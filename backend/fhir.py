"""FHIR R4 export of one examination.

The system holds no patient data and is not going to start: the ROI crop
exists partly to remove the identifiers printed down the left of the console
output.  So the export takes the subject as an argument — the caller says which
`Patient` these findings belong to, and the reference is written into the
bundle without this system ever learning who that is.

**The codes here are local.**  Every `code` and `bodySite` uses this project's
own CodeSystem URI, not SNOMED CT or LOINC.  That is deliberate and it is not
finished work: binding these to a standard terminology has to be done by
someone who can verify each concept individually, because a code that is merely
plausible is worse than one that is obviously local — `bodySite` naming the
wrong organ would be read as fact by whatever consumes it.  See docs/FHIR.md.
"""

from typing import Iterator, List, Optional

from backend.protocol import GIM_REGIONS, FrameRecord, SessionManifest

FHIR_VERSION = "4.0.1"

# This project's own concepts, until someone binds them to SNOMED CT / LOINC.
BASE = "https://github.com/hook123152828/EsophagoGastroDuodenoscopy"
CS = BASE + "/CodeSystem"

REGION_DISPLAY = {
    "esophagus": "Esophagus",
    "cardia": "Cardia / fundus",
    "body": "Body of stomach",
    "angle": "Angular incisure",
    "antrum": "Gastric antrum",
    "duodenum": "Duodenum",
    "unknown": "Unclassified",
}

# One entry per model that can contribute a finding. Versions are the weight
# files, which is what actually decides the output — see docs/IEC62304.md §5.
DEVICES = [
    ("gns", "SGAFormer", "Anatomical site classification", "best_94.0050_AIGNS.pth"),
    ("gim", "Mask Focal Modulation Network", "Intestinal metaplasia segmentation", "epoch_50_bd.pth"),
    ("polyp", "YOLO + MedSAM", "Polyp detection and segmentation", "polyp_yolo.pt + medsam_vit_b.pth"),
]

# Agreement required before a run of frames is reported as one finding. The
# same rule the live page draws by and the report page builds episodes from —
# a third copy, which is a cost worth naming: if one moves the others must.
# frontend/src/protocol/lookup.ts, frontend/src/pages/report/reportPipeline.ts
CONSENSUS_OF, CONSENSUS_IN, CONSENSUS_WINDOW_S = 2, 3, 1.0

# How long a gap may be before two confirmed frames are separate findings.
EPISODE_GAP_S = 2.0


def _confirmed(frames: List[FrameRecord], index: int) -> bool:
    at = frames[index]
    considered = positive = 0
    for i in range(index, -1, -1):
        frame = frames[i]
        if frame.gim is None:
            continue
        if at.t - frame.t > CONSENSUS_WINDOW_S:
            break
        considered += 1
        if frame.gim.mask_url:
            positive += 1
        if considered >= CONSENSUS_IN:
            break
    return considered >= CONSENSUS_IN and positive >= CONSENSUS_OF


def _im_episodes(frames: List[FrameRecord]) -> Iterator[dict]:
    """Runs of corroborated IM frames, one dict per episode."""
    episode: Optional[dict] = None

    for index, frame in enumerate(frames):
        if not (frame.gim and frame.gim.mask_url and _confirmed(frames, index)):
            continue
        # GIM is a gastric model. Sessions scanned before the gateway enforced
        # that carry results outside the stomach, and exporting one as a
        # clinical finding would put a site on it the model was never trained
        # to speak about.
        if not frame.gns or frame.gns.region not in GIM_REGIONS:
            continue

        if episode and frame.t - episode["end"] <= EPISODE_GAP_S:
            episode["end"] = frame.t
            episode["frames"] += 1
            if frame.gim.area > episode["peak_area"]:
                episode["peak_area"] = frame.gim.area
                episode["peak_score"] = frame.gim.score
                episode["peak_t"] = frame.t
                episode["region"] = frame.gns.region if frame.gns else "unknown"
        else:
            if episode:
                yield episode
            episode = {
                "start": frame.t, "end": frame.t, "frames": 1,
                "peak_area": frame.gim.area, "peak_score": frame.gim.score,
                "peak_t": frame.t,
                "region": frame.gns.region if frame.gns else "unknown",
            }

    if episode:
        yield episode


def _offset(seconds: float) -> dict:
    """Where in the recording something was seen.

    Carried as an offset rather than an `effectiveDateTime`: the wall-clock
    time the procedure was recorded is not in the data, and inventing one would
    put a fabricated timestamp on a clinical finding.
    """
    return {
        "code": {
            "coding": [{"system": CS + "/observation", "code": "video-offset"}],
            "text": "Offset into the recording",
        },
        "valueQuantity": {
            "value": round(seconds, 2),
            "unit": "s",
            "system": "http://unitsofmeasure.org",
            "code": "s",
        },
    }


def _body_site(region: str) -> dict:
    return {
        "coding": [{"system": CS + "/body-site", "code": region,
                    "display": REGION_DISPLAY.get(region, region)}],
        "text": REGION_DISPLAY.get(region, region),
    }


def build_bundle(
    manifest: SessionManifest, frames: List[FrameRecord], subject: str
) -> dict:
    """A FHIR R4 collection Bundle for one examination.

    ``subject`` is a reference the caller supplies, e.g. ``Patient/12345``.
    """
    session = manifest.session_id
    study_id = f"imagingstudy-{session}"
    entries: List[dict] = []

    def add(resource: dict) -> str:
        # An absolute fullUrl with relative references, so a consumer resolves
        # them against the bundle. urn:uuid: would need the ids to be real
        # UUIDs, and these are meant to be readable.
        relative = f"{resource['resourceType']}/{resource['id']}"
        entries.append({"fullUrl": f"{BASE}/fhir/{relative}", "resource": resource})
        return relative

    device_refs = {}
    for key, name, purpose, version in DEVICES:
        device_refs[key] = add({
            "resourceType": "Device",
            "id": f"device-{key}",
            "status": "active",
            "deviceName": [{"name": name, "type": "model-name"}],
            "type": {"text": purpose},
            "version": [{"value": version}],
            "note": [{"text": "Research software. Not a regulated medical device."}],
        })

    study_ref = add({
        "resourceType": "ImagingStudy",
        "id": study_id,
        "status": "available",
        "subject": {"reference": subject},
        "started": manifest.created_at,
        "description": f"Upper GI endoscopy — {manifest.video.filename}",
        "numberOfInstances": manifest.frame_count,
        "note": [{"text":
            f"Frames cropped to ROI x={manifest.roi.x} y={manifest.roi.y} "
            f"{manifest.roi.width}x{manifest.roi.height}; sampling "
            f"extract={manifest.sampling.extract_fps} gns={manifest.sampling.gns_fps} "
            f"gim={manifest.sampling.gim_fps} fps."}],
    })

    results: List[str] = []

    # --- coverage: which sites the examination actually reached ---
    seen: dict = {}
    for frame in frames:
        if frame.gns and frame.gns.region != "unknown":
            seen.setdefault(frame.gns.region, 0)
            seen[frame.gns.region] += 1
    if seen:
        step = 1.0 / max(manifest.sampling.extract_fps, 1e-6)
        results.append(add({
            "resourceType": "Observation",
            "id": f"observation-coverage-{session}",
            "status": "final",
            "category": [{"coding": [{
                "system": "http://terminology.hl7.org/CodeSystem/observation-category",
                "code": "imaging"}]}],
            "code": {"coding": [{"system": CS + "/observation", "code": "site-coverage"}],
                     "text": "Time spent at each anatomical site"},
            "subject": {"reference": subject},
            "device": {"reference": device_refs["gns"]},
            "derivedFrom": [{"reference": study_ref}],
            "component": [{
                "code": _body_site(region),
                "valueQuantity": {"value": round(count * step, 1), "unit": "s",
                                  "system": "http://unitsofmeasure.org", "code": "s"},
            } for region, count in sorted(seen.items())],
        }))

    # --- intestinal metaplasia, one Observation per episode ---
    for number, episode in enumerate(_im_episodes(frames), start=1):
        results.append(add({
            "resourceType": "Observation",
            "id": f"observation-im-{session}-{number}",
            "status": "preliminary",
            "category": [{"coding": [{
                "system": "http://terminology.hl7.org/CodeSystem/observation-category",
                "code": "imaging"}]}],
            "code": {"coding": [{"system": CS + "/observation", "code": "gastric-intestinal-metaplasia"}],
                     "text": "Gastric intestinal metaplasia (model finding)"},
            "subject": {"reference": subject},
            "bodySite": _body_site(episode["region"]),
            "device": {"reference": device_refs["gim"]},
            "derivedFrom": [{"reference": study_ref}],
            "valueInteger": episode["peak_score"],
            "component": [
                _offset(episode["peak_t"]),
                {"code": {"coding": [{"system": CS + "/observation", "code": "affected-area"}],
                          "text": "Share of the endoscope field affected, at its peak"},
                 "valueQuantity": {"value": episode["peak_area"], "unit": "%",
                                   "system": "http://unitsofmeasure.org", "code": "%"}},
                {"code": {"coding": [{"system": CS + "/observation", "code": "episode-duration"}],
                          "text": "Duration the finding was corroborated for"},
                 "valueQuantity": {"value": round(episode["end"] - episode["start"], 2),
                                   "unit": "s", "system": "http://unitsofmeasure.org", "code": "s"}},
            ],
        }))

    # --- polyps: only where someone asked for them, so often none ---
    for number, frame in enumerate(
        (f for f in frames if f.polyp and f.polyp.boxes), start=1
    ):
        results.append(add({
            "resourceType": "Observation",
            "id": f"observation-polyp-{session}-{number}",
            "status": "preliminary",
            "category": [{"coding": [{
                "system": "http://terminology.hl7.org/CodeSystem/observation-category",
                "code": "imaging"}]}],
            "code": {"coding": [{"system": CS + "/observation", "code": "gastric-polyp"}],
                     "text": "Gastric polyp (model finding)"},
            "subject": {"reference": subject},
            "bodySite": _body_site(frame.gns.region if frame.gns else "unknown"),
            "device": {"reference": device_refs["polyp"]},
            "derivedFrom": [{"reference": study_ref}],
            "valueInteger": len(frame.polyp.boxes),
            "component": [
                _offset(frame.t),
                {"code": {"coding": [{"system": CS + "/observation", "code": "affected-area"}],
                          "text": "Share of the endoscope field covered by the segmentation"},
                 "valueQuantity": {"value": frame.polyp.area, "unit": "%",
                                   "system": "http://unitsofmeasure.org", "code": "%"}},
                {"code": {"coding": [{"system": CS + "/observation", "code": "detector-confidence"}],
                          "text": "Highest detector confidence on this frame"},
                 "valueQuantity": {"value": round(max(b.confidence for b in frame.polyp.boxes), 4)}},
            ],
        }))

    add({
        "resourceType": "DiagnosticReport",
        "id": f"diagnosticreport-{session}",
        # Preliminary, and it stays preliminary: nothing here has been seen by
        # a clinician, and the standard has no status for "machine output".
        "status": "preliminary",
        "category": [{"coding": [{
            "system": "http://terminology.hl7.org/CodeSystem/v2-0074", "code": "OTH"}],
            "text": "Endoscopy"}],
        "code": {"coding": [{"system": CS + "/report", "code": "egd-ai-assisted"}],
                 "text": "Upper GI endoscopy — AI-assisted findings"},
        "subject": {"reference": subject},
        "issued": manifest.created_at,
        "imagingStudy": [{"reference": study_ref}],
        "result": [{"reference": ref} for ref in results],
        "conclusion": (
            "Model output only. Every finding here is decision support and must be "
            "interpreted with the full examination by a qualified clinician. Codes "
            "are local to this project and are not bound to SNOMED CT or LOINC."
        ),
    })

    return {
        "resourceType": "Bundle",
        "id": f"bundle-{session}",
        "type": "collection",
        "timestamp": manifest.created_at,
        "entry": entries,
    }
