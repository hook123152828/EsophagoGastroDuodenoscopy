"""Gateway — the only service either page talks to.

Owns the session lifecycle:

    extracting -> scanning -> ready
                          \-> failed

It crops frames out of the console output with ffmpeg, runs GNS over them, runs
GIM over the NBI ones, and publishes progress over SSE.  Page 1 creates
sessions; page 2 consumes them.  Neither page calls the other.

See docs/PROTOCOL.md — that file is the contract, this file implements it.
"""

import asyncio
import json
import shutil
import subprocess
import uuid
from collections import deque
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

import httpx
import uvicorn
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from backend import config
from backend.protocol import (
    POLYP_REGIONS,
    AnalyzeRequest,
    CgiRequest,
    CreateSessionRequest,
    FrameRecord,
    GimResult,
    GnsResult,
    PolypResult,
    Progress,
    Roi,
    Sampling,
    SessionManifest,
    VideoInfo,
)

VIDEO_SUFFIXES = {".mp4", ".avi", ".mov", ".mkv"}


# --- Session store -----------------------------------------------------------
class Session:
    """One procedure. Manifest lives in memory and on disk; frames on disk."""

    def __init__(self, manifest: SessionManifest) -> None:
        self.manifest = manifest
        self.frames: List[FrameRecord] = []
        self.subscribers: List[asyncio.Queue] = []
        # Held so the session can be torn down mid-flight: both the pipeline
        # task and ffmpeg keep writing into the directory otherwise, and
        # Session.save() would recreate what was just deleted.
        self.task: Optional[asyncio.Task] = None
        self.ffmpeg: Optional[asyncio.subprocess.Process] = None
        # Serialises on-demand analysis so a misbehaving client cannot pile
        # unbounded concurrent inference onto the GPU.
        self.analyze_lock = asyncio.Lock()

    @property
    def directory(self) -> Path:
        return config.SESSION_DIR / self.manifest.session_id

    def publish(self, event: dict) -> None:
        for queue in self.subscribers:
            queue.put_nowait(event)

    def publish_frames(self, frames: List[FrameRecord]) -> None:
        """Push freshly analysed frames so clients fill in as results land."""
        if not frames:
            return
        self.publish(
            {
                "type": "frames",
                "session_id": self.manifest.session_id,
                "frames": [frame.model_dump() for frame in frames],
            }
        )

    def set_status(self, status: str, error: Optional[str] = None) -> None:
        self.manifest.status = status
        self.manifest.error = error
        self.save()
        self.publish(
            {
                "type": "status",
                "session_id": self.manifest.session_id,
                "status": status,
                "error": error,
            }
        )
        if status == "ready":
            self.publish(
                {
                    "type": "ready",
                    "session_id": self.manifest.session_id,
                    "frame_count": self.manifest.frame_count,
                }
            )

    def set_progress(self, **kwargs: float) -> None:
        for key, value in kwargs.items():
            setattr(self.manifest.progress, key, round(value, 4))
        self.publish(
            {
                "type": "progress",
                "session_id": self.manifest.session_id,
                "progress": self.manifest.progress.model_dump(),
            }
        )

    def save(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        (self.directory / "manifest.json").write_text(
            self.manifest.model_dump_json(indent=2)
        )

    def save_frames(self) -> None:
        with (self.directory / "frames.jsonl").open("w") as handle:
            for frame in self.frames:
                handle.write(frame.model_dump_json() + "\n")


SESSIONS: Dict[str, Session] = {}


# --- Video probing -----------------------------------------------------------
def probe(path: Path) -> VideoInfo:
    result = subprocess.run(
        [
            config.FFPROBE_BIN, "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height,r_frame_rate:format=duration",
            "-of", "json", str(path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    payload = json.loads(result.stdout)
    stream = payload["streams"][0]
    numerator, _, denominator = stream["r_frame_rate"].partition("/")

    try:
        media_url = f"/media/{path.relative_to(config.VIDEO_DIR)}"
    except ValueError:
        media_url = None  # outside VIDEO_DIR, not streamable

    return VideoInfo(
        path=str(path),
        filename=path.name,
        width=stream["width"],
        height=stream["height"],
        fps=float(numerator) / float(denominator or 1),
        duration_s=float(payload["format"]["duration"]),
        media_url=media_url,
    )


# --- Pipeline ----------------------------------------------------------------
def build_frame_list(session: Session, count: int) -> List[FrameRecord]:
    session_id = session.manifest.session_id
    fps = session.manifest.sampling.extract_fps
    return [
        FrameRecord(
            index=index,
            t=round(index / fps, 4),
            image_url=f"/files/{session_id}/frames/{index + 1:06d}.jpg",
        )
        for index in range(count)
    ]


def frame_path(session: Session, index: int) -> Path:
    return session.directory / "frames" / f"{index + 1:06d}.jpg"


async def extract_frames(session: Session) -> None:
    """ffmpeg crops the endoscope viewport out and resamples to extract_fps."""
    roi = session.manifest.roi
    frames_dir = session.directory / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    process = await asyncio.create_subprocess_exec(
        config.FFMPEG_BIN, "-loglevel", "error", "-i", session.manifest.video.path,
        "-vf", f"crop={roi.width}:{roi.height}:{roi.x}:{roi.y},"
               f"fps={session.manifest.sampling.extract_fps}",
        "-q:v", "3", str(frames_dir / "%06d.jpg"),
        stderr=asyncio.subprocess.PIPE,
    )
    session.ffmpeg = process

    expected = max(
        1,
        int(session.manifest.video.duration_s * session.manifest.sampling.extract_fps),
    )
    while process.returncode is None:
        try:
            await asyncio.wait_for(process.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            written = sum(1 for _ in frames_dir.glob("*.jpg"))
            session.set_progress(extract=min(0.99, written / expected))

    if process.returncode != 0:
        stderr = (await process.stderr.read()).decode()[:500]
        raise RuntimeError(f"ffmpeg failed: {stderr}")

    # Reconcile the predicted table against what ffmpeg actually wrote. Frames
    # already analysed on demand keep their results.
    actual = sum(1 for _ in frames_dir.glob("*.jpg"))
    if actual > len(session.frames):
        session.frames.extend(
            build_frame_list(session, actual)[len(session.frames) :]
        )
    elif actual < len(session.frames):
        del session.frames[actual:]

    session.ffmpeg = None
    session.manifest.frame_count = len(session.frames)
    session.set_progress(extract=1.0)


def _stride(sampling_fps: float, extract_fps: float) -> int:
    return max(1, round(extract_fps / max(sampling_fps, 1e-6)))


async def _windowed(make_task, count: int, width: int):
    """Run ``count`` tasks with ``width`` in flight, yielding results in order.

    Order matters more than it looks: GIM is fed from how far GNS has got, and
    a frontier that only ever moves forward is what makes "everything before
    here has been classified" true. Completing out of order would break that,
    so results are awaited in the order they were submitted even though they
    are computed together.
    """
    pending: deque = deque()
    submitted = 0
    while submitted < count or pending:
        while submitted < count and len(pending) < width:
            pending.append(asyncio.create_task(make_task(submitted)))
            submitted += 1
        yield await pending.popleft()


async def _in_halves(run, items: list) -> list:
    """Run ``run`` over ``items``, splitting the batch if the model refuses it.

    Both stages are on the GPU at once now, and a card shared with anything else
    can have room for one batch but not two. Losing a scan at nine percent
    because a neighbour spiked is a worse failure than taking longer, so a batch
    that fails is halved and retried rather than abandoned. A single frame that
    still fails is a real error and is allowed through.
    """
    try:
        return await run(items)
    except Exception:
        if len(items) == 1:
            raise
        # Give whatever was holding the memory a moment to give it back.
        await asyncio.sleep(0.5)
        middle = len(items) // 2
        head = await _in_halves(run, items[:middle])
        tail = await _in_halves(run, items[middle:])
        return head + tail


async def run_scan(session: Session, client: httpx.AsyncClient) -> None:
    """Classify the procedure and segment it, both at the same time.

    GIM used to wait for GNS to finish the whole video before it started, which
    left one model idle throughout the other's pass. It does not need to: it
    only ever looks at frames GNS has already called NBI, so it can follow the
    classification as it advances instead of following the pass as a whole. The
    two run as producer and consumer over a queue, which roughly halves the
    scan on a procedure with much NBI in it and costs nothing on one with none.
    """
    sampling = session.manifest.sampling
    gns_stride = _stride(sampling.gns_fps, sampling.extract_fps)
    gim_stride = _stride(sampling.gim_fps, sampling.extract_fps)

    targets = session.frames[::gns_stride]
    batches = [
        targets[start : start + config.GNS_BATCH]
        for start in range(0, len(targets), config.GNS_BATCH)
    ]

    masks_dir = session.directory / "masks"
    session_id = session.manifest.session_id
    # Bounded so a long NBI run cannot let the queue grow without limit while
    # GIM, the slower of the two, works through it.
    queue: asyncio.Queue = asyncio.Queue(maxsize=8)
    state = {"discovered": 0, "processed": 0, "classified": False, "reported": 0.0}

    async def classify() -> None:
        async def gns_batch(index: int) -> List[FrameRecord]:
            batch = batches[index]
            # Frames the user already jumped to were analysed on demand; don't
            # pay for them twice.
            pending = [frame for frame in batch if frame.gns is None]
            if pending:
                async def classify_frames(frames: List[FrameRecord]) -> list:
                    response = await client.post(
                        f"{config.GNS_URL}/predict",
                        json={
                            "paths": [
                                str(frame_path(session, f.index)) for f in frames
                            ]
                        },
                        timeout=120.0,
                    )
                    response.raise_for_status()
                    return response.json()["results"]

                for frame, result in zip(
                    pending, await _in_halves(classify_frames, pending)
                ):
                    frame.gns = GnsResult(**result)
            return batch

        # Frames between GNS samples inherit the nearest earlier classification.
        # Done as the frontier advances rather than in a pass at the end, so a
        # GIM target that sits between two samples is available immediately.
        frontier = 0
        inherited: Optional[GnsResult] = None
        done = 0

        async for batch in _windowed(gns_batch, len(batches), config.SCAN_CONCURRENCY):
            session.publish_frames(batch)
            done += len(batch)
            session.set_progress(gns=min(1.0, done / max(len(targets), 1)))

            ready: List[FrameRecord] = []
            while frontier <= batch[-1].index:
                frame = session.frames[frontier]
                if frame.gns is not None:
                    inherited = frame.gns
                elif inherited is not None:
                    frame.gns = inherited
                if (
                    frontier % gim_stride == 0
                    and frame.gns is not None
                    and frame.gns.modality == "NBI"
                    and frame.gim is None
                ):
                    ready.append(frame)
                frontier += 1

            if ready:
                state["discovered"] += len(ready)
                await queue.put(ready)

        state["classified"] = True
        session.set_progress(gns=1.0)
        await queue.put(None)

    async def segment() -> None:
        """GIM is NBI-only — white-light frames never reach this queue."""
        batch_size = 8
        while True:
            ready = await queue.get()
            if ready is None:
                break

            masks_dir.mkdir(parents=True, exist_ok=True)
            for start in range(0, len(ready), batch_size):
                chunk = ready[start : start + batch_size]

                async def segment_frames(frames: List[FrameRecord]) -> list:
                    response = await client.post(
                        f"{config.GIM_URL}/predict",
                        json={
                            "items": [
                                {
                                    "path": str(frame_path(session, frame.index)),
                                    "mask_out": str(
                                        masks_dir / f"{frame.index + 1:06d}.png"
                                    ),
                                }
                                for frame in frames
                            ]
                        },
                        timeout=180.0,
                    )
                    response.raise_for_status()
                    return response.json()["results"]

                for frame, result in zip(
                    chunk, await _in_halves(segment_frames, chunk)
                ):
                    frame.gim = GimResult(
                        score=result["score"],
                        area=result["area"],
                        mask_url=(
                            f"/files/{session_id}/masks/{frame.index + 1:06d}.png"
                            if result["has_mask"]
                            else None
                        ),
                    )
                session.publish_frames(chunk)
                state["processed"] += len(chunk)

                # How much is owed is not known until GNS has seen the whole
                # video, so until then the readout is held below completion
                # rather than claiming to be done and then finding more work.
                # It is also pinned to its high-water mark: the denominator
                # grows as GNS turns up more NBI, and a bar that slides
                # backwards reads as a fault rather than as new work arriving.
                share = state["processed"] / max(state["discovered"], 1)
                if not state["classified"]:
                    share = min(share, 0.99)
                state["reported"] = max(state["reported"], share)
                session.set_progress(gim=state["reported"])

        session.set_progress(gim=1.0)

    # gather rather than two awaits: an exception in either must not leave the
    # other running against a session that is already failing.
    await asyncio.gather(classify(), segment())


async def process(session: Session) -> None:
    try:
        await extract_frames(session)
        session.set_status("scanning")
        async with httpx.AsyncClient() as client:
            await run_scan(session, client)
        session.save_frames()
        session.set_status("ready")
    except Exception as error:  # surfaced to both pages via manifest + SSE
        session.save_frames()
        session.set_status("failed", str(error))


# --- App ---------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fail loudly at startup rather than at the first upload: whether ffmpeg is
    # reachable depends on the launching shell's PATH, so this differs between
    # running by hand and running from scripts/start_services.sh.
    missing = config.missing_binaries()
    if missing:
        print(
            f"!! {', '.join(missing)} not found — sessions cannot be created.\n"
            f"   Install ffmpeg into the gateway environment, or set "
            f"FFMPEG_BIN / FFPROBE_BIN. See README.md."
        )
    else:
        print(f"ffmpeg: {config.FFMPEG_BIN}")

    config.SESSION_DIR.mkdir(parents=True, exist_ok=True)
    for directory in sorted(config.SESSION_DIR.iterdir()):
        manifest_file = directory / "manifest.json"
        if not manifest_file.exists():
            continue
        session = Session(SessionManifest.model_validate_json(manifest_file.read_text()))
        frames_file = directory / "frames.jsonl"
        if frames_file.exists():
            session.frames = [
                FrameRecord.model_validate_json(line)
                for line in frames_file.read_text().splitlines()
                if line
            ]
        SESSIONS[session.manifest.session_id] = session
    yield


app = FastAPI(title="Upper GI Endoscopy Gateway", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.FRONTEND_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)
config.SESSION_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/files", StaticFiles(directory=str(config.SESSION_DIR)), name="files")
# Created up front rather than checked, so uploads have somewhere to land and
# /media is always mounted. Starlette's FileResponse honours Range requests, so
# <video> can seek through a multi-GB source without downloading it.
config.VIDEO_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/media", StaticFiles(directory=str(config.VIDEO_DIR)), name="media")


def _session(session_id: str) -> Session:
    session = SESSIONS.get(session_id)
    if session is None:
        raise HTTPException(404, f"Unknown session {session_id}")
    return session


@app.get("/api/health")
async def health() -> dict:
    async with httpx.AsyncClient(timeout=2.0) as client:

        async def up(url: str) -> bool:
            try:
                return (await client.get(f"{url}/health")).status_code < 500
            except httpx.RequestError:
                return False

        gns, gim, cgi, polyp = await asyncio.gather(
            up(config.GNS_URL),
            up(config.GIM_URL),
            up(config.CGI_URL),
            up(config.POLYP_URL),
        )
    return {"gateway": True, "gns": gns, "gim": gim, "cgi": cgi, "polyp": polyp}


@app.get("/api/videos")
def list_videos() -> dict:
    if not config.VIDEO_DIR.exists():
        return {"videos": []}
    return {
        "videos": [
            {
                "path": str(path),
                "filename": path.name,
                "size_bytes": path.stat().st_size,
            }
            for path in sorted(config.VIDEO_DIR.iterdir())
            if path.suffix.lower() in VIDEO_SUFFIXES
        ]
    }


@app.post("/api/videos", status_code=201)
async def upload_video(file: UploadFile = File(...)) -> dict:
    """Take a video from the browser into VIDEO_DIR.

    Streamed to disk in chunks — a procedure recording is several GB and must
    never be held in memory. The name is reduced to its basename so an upload
    cannot write outside VIDEO_DIR.
    """
    name = Path(file.filename or "upload.mp4").name
    if Path(name).suffix.lower() not in VIDEO_SUFFIXES:
        raise HTTPException(
            400, f"Unsupported video type: {Path(name).suffix or '(none)'}"
        )

    config.VIDEO_DIR.mkdir(parents=True, exist_ok=True)
    target = config.VIDEO_DIR / name
    stem, suffix = target.stem, target.suffix
    counter = 1
    while target.exists():
        target = config.VIDEO_DIR / f"{stem}-{counter}{suffix}"
        counter += 1

    try:
        with target.open("wb") as handle:
            while chunk := await file.read(4 * 1024 * 1024):
                handle.write(chunk)
    except Exception:
        target.unlink(missing_ok=True)
        raise

    return {
        "path": str(target),
        "filename": target.name,
        "size_bytes": target.stat().st_size,
    }


@app.post("/api/sessions", status_code=201)
async def create_session(request: CreateSessionRequest) -> SessionManifest:
    path = Path(request.video_path).expanduser().resolve()
    if not path.exists():
        raise HTTPException(400, f"No such video: {path}")

    # Raised as HTTP errors rather than letting them escape: an unhandled
    # exception bypasses the CORS middleware, so the browser sees only
    # "TypeError: Failed to fetch" and the real cause stays buried in the log.
    missing = config.missing_binaries()
    if missing:
        raise HTTPException(
            503,
            f"{', '.join(missing)} not found on the gateway. Install ffmpeg into "
            f"the gateway environment or set FFMPEG_BIN / FFPROBE_BIN.",
        )

    try:
        video = probe(path)
    except (subprocess.CalledProcessError, OSError, KeyError, ValueError) as error:
        raise HTTPException(500, f"Could not read {path.name}: {error}") from error

    manifest = SessionManifest(
        session_id=uuid.uuid4().hex,
        created_at=datetime.now(timezone.utc).isoformat(),
        status="extracting",
        video=video,
        roi=Roi(),
        sampling=request.sampling or Sampling(),
        progress=Progress(),
    )
    session = Session(manifest)
    # The frame table is laid out before ffmpeg runs so that on-demand analysis
    # has a slot to write into from the very first second — otherwise nothing
    # could be analysed until extraction finished.
    session.frames = build_frame_list(
        session,
        max(1, int(manifest.video.duration_s * manifest.sampling.extract_fps)),
    )
    manifest.frame_count = len(session.frames)
    session.save()
    SESSIONS[manifest.session_id] = session
    session.task = asyncio.create_task(process(session))
    return manifest


@app.get("/api/sessions")
def list_sessions() -> List[SessionManifest]:
    return sorted(
        (session.manifest for session in SESSIONS.values()),
        key=lambda manifest: manifest.created_at,
        reverse=True,
    )


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str) -> SessionManifest:
    return _session(session_id).manifest


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str) -> dict:
    """Forget a session and delete everything it wrote.

    A session that is still processing is stopped first: the pipeline task is
    cancelled and its ffmpeg killed, because either would go on writing into
    the directory — ``Session.save()`` recreates it — and leave behind the half
    a session this is meant to clear out.

    Frames are the bulk of it: a 14-minute procedure at 60 fps is ~4 GB.
    """
    session = _session(session_id)
    SESSIONS.pop(session_id, None)

    if session.task is not None:
        session.task.cancel()
        with suppress(asyncio.CancelledError):
            await session.task
    if session.ffmpeg is not None and session.ffmpeg.returncode is None:
        session.ffmpeg.kill()

    shutil.rmtree(session.directory, ignore_errors=True)
    return {"deleted": session_id}


@app.get("/api/sessions/{session_id}/frames")
def get_frames(
    session_id: str,
    from_t: Optional[float] = None,
    to_t: Optional[float] = None,
    only_scanned: bool = False,
) -> dict:
    session = _session(session_id)
    frames = session.frames
    if from_t is not None:
        frames = [frame for frame in frames if frame.t >= from_t]
    if to_t is not None:
        frames = [frame for frame in frames if frame.t <= to_t]
    if only_scanned:
        frames = [frame for frame in frames if frame.gns is not None]
    return {"session_id": session_id, "count": len(frames), "frames": frames}


async def extract_single_frame(session: Session, index: int) -> None:
    """Pull one frame straight out of the source, ahead of the bulk extraction.

    Only needed in the first seconds of a session: ffmpeg's keyframe seek is
    O(1) in position (~200ms anywhere in a 14-minute file), but once the bulk
    extraction has passed this timestamp the file is already on disk.
    """
    roi = session.manifest.roi
    path = frame_path(session, index)
    path.parent.mkdir(parents=True, exist_ok=True)

    process = await asyncio.create_subprocess_exec(
        config.FFMPEG_BIN, "-loglevel", "error",
        "-ss", str(index / session.manifest.sampling.extract_fps),
        "-i", session.manifest.video.path,
        "-frames:v", "1",
        "-vf", f"crop={roi.width}:{roi.height}:{roi.x}:{roi.y}",
        "-q:v", "3", "-y", str(path),
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await process.communicate()
    if process.returncode != 0 or not path.exists():
        raise HTTPException(500, f"ffmpeg seek failed: {stderr.decode()[:300]}")


def pending(frame: FrameRecord) -> bool:
    """Whether anything is still owed on this frame.

    A white-light frame is finished once GNS has run — GIM is NBI-only. An NBI
    frame is not: the scan runs its GIM pass only after GNS has covered the
    whole procedure, so for most of a session the frame under the playhead has
    a site but no mask, and closing that gap is what on-demand analysis is for.
    """
    if frame.gns is None:
        return True
    return frame.gns.modality == "NBI" and frame.gim is None


def polyp_applies(gns: Optional[GnsResult]) -> bool:
    """Whether the polyp pass is defined on a frame GNS classified this way.

    The detector was fine-tuned on white-light stomach and nothing else, so
    NBI and everything outside the stomach are refused here rather than served
    a confident answer to a question the model was never asked.
    """
    return gns is not None and gns.modality == "WL" and gns.region in POLYP_REGIONS


@app.post("/api/sessions/{session_id}/analyze")
async def analyze(session_id: str, request: AnalyzeRequest) -> FrameRecord:
    """Analyse the frame at ``t`` now, rather than waiting for the scan.

    Fills in whatever that frame is still missing — the site, the IM mask, or
    both. Results are written back into the session, so the background scan
    skips them and page 2 sees exactly what page 1 showed.

    ``polyp`` additionally runs detection plus segmentation, which no scan ever
    does: it costs roughly ten times a GIM frame, so it is opt-in and asked for
    only by a caller about to show or record the result.
    """
    session = _session(session_id)
    if not session.frames:
        raise HTTPException(409, "Session has no frame table yet")

    index = min(
        max(0, round(request.t * session.manifest.sampling.extract_fps)),
        len(session.frames) - 1,
    )
    frame = session.frames[index]

    def owed() -> bool:
        if pending(frame):
            return True
        # Applicability needs the site, so a frame without GNS yet is already
        # pending above; by here the answer is known.
        return request.polyp and frame.polyp is None and polyp_applies(frame.gns)

    if not owed():
        return frame  # already covered by the scan or an earlier request

    async with session.analyze_lock:
        if not owed():
            return frame

        if not frame_path(session, index).exists():
            await extract_single_frame(session, index)

        async with httpx.AsyncClient() as client:
            if frame.gns is None:
                response = await client.post(
                    f"{config.GNS_URL}/predict",
                    json={"paths": [str(frame_path(session, index))]},
                    timeout=30.0,
                )
                response.raise_for_status()
                frame.gns = GnsResult(**response.json()["results"][0])

            # GIM is valid only for non-esophageal NBI frames — the same rule
            # used by the background scan.
            if is_gim_candidate(frame) and frame.gim is None:
                masks_dir = session.directory / "masks"
                masks_dir.mkdir(parents=True, exist_ok=True)
                mask_out = masks_dir / f"{index + 1:06d}.png"
                response = await client.post(
                    f"{config.GIM_URL}/predict",
                    json={
                        "items": [
                            {
                                "path": str(frame_path(session, index)),
                                "mask_out": str(mask_out),
                            }
                        ]
                    },
                    timeout=60.0,
                )
                response.raise_for_status()
                result = response.json()["results"][0]
                frame.gim = GimResult(
                    score=result["score"],
                    area=result["area"],
                    mask_url=(
                        f"/files/{session_id}/masks/{index + 1:06d}.png"
                        if result["has_mask"]
                        else None
                    ),
                )

            if request.polyp and frame.polyp is None and polyp_applies(frame.gns):
                # A directory of its own: a frame can carry both an IM mask and
                # a polyp mask, and they would otherwise collide on the index.
                polyp_dir = session.directory / "polyp_masks"
                polyp_dir.mkdir(parents=True, exist_ok=True)
                mask_out = polyp_dir / f"{index + 1:06d}.png"
                response = await client.post(
                    f"{config.POLYP_URL}/predict",
                    json={
                        "items": [
                            {
                                "path": str(frame_path(session, index)),
                                "mask_out": str(mask_out),
                            }
                        ]
                    },
                    timeout=60.0,
                )
                response.raise_for_status()
                result = response.json()["results"][0]
                frame.polyp = PolypResult(
                    boxes=result["boxes"],
                    area=result["area"],
                    mask_url=(
                        f"/files/{session_id}/polyp_masks/{index + 1:06d}.png"
                        if result["has_mask"]
                        else None
                    ),
                )

    session.publish_frames([frame])
    return frame


@app.get("/api/sessions/{session_id}/events")
async def events(session_id: str) -> StreamingResponse:
    session = _session(session_id)
    queue: asyncio.Queue = asyncio.Queue()
    session.subscribers.append(queue)

    async def stream():
        # Replay current state so a late subscriber is never left guessing.
        initial = [
            {
                "type": "status",
                "session_id": session_id,
                "status": session.manifest.status,
                "error": session.manifest.error,
            },
            {
                "type": "progress",
                "session_id": session_id,
                "progress": session.manifest.progress.model_dump(),
            },
        ]
        if session.manifest.status == "ready":
            initial.append(
                {
                    "type": "ready",
                    "session_id": session_id,
                    "frame_count": session.manifest.frame_count,
                }
            )
        try:
            for event in initial:
                yield f"data: {json.dumps(event)}\n\n"
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"data: {json.dumps(event)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            session.subscribers.remove(queue)

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.post("/api/cgi/predict")
async def cgi_predict(request: CgiRequest) -> dict:
    """Pass-through to the CGI service. Pool selection belongs to page 2."""
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            response = await client.post(
                f"{config.CGI_URL}/predict_cgi_batch", json=request.model_dump()
            )
            response.raise_for_status()
            return response.json()
    except httpx.HTTPError as error:
        raise HTTPException(502, f"CGI service error: {error}") from error


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=config.GATEWAY_PORT)
