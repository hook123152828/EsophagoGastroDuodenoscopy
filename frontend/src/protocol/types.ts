/**
 * The contract between page 1 and page 2 — TypeScript side.
 *
 * Mirrors `backend/protocol.py`. The specification is `docs/PROTOCOL.md`;
 * all three must be changed together.
 *
 * Nothing under `pages/` may define its own copy of these shapes.
 */

export const PROTOCOL_VERSION = 1

export type SessionStatus = 'extracting' | 'scanning' | 'ready' | 'failed'

export type Modality = 'WL' | 'NBI'

export type RegionId =
  | 'esophagus'
  | 'cardia'
  | 'body'
  | 'angle'
  | 'antrum'
  | 'duodenum'
  | 'unknown'

export interface Roi {
  x: number
  y: number
  width: number
  height: number
}

export interface Sampling {
  extract_fps: number
  gns_fps: number
  gim_fps: number
}

export interface VideoInfo {
  path: string
  filename: string
  width: number
  height: number
  fps: number
  duration_s: number
  /** Streamable URL for <video>; null when the file lives outside VIDEO_DIR. */
  media_url: string | null
}

export interface Progress {
  extract: number
  gns: number
  gim: number
}

export interface SessionManifest {
  protocol_version: number
  session_id: string
  created_at: string
  status: SessionStatus
  error: string | null
  video: VideoInfo
  roi: Roi
  sampling: Sampling
  frame_count: number
  progress: Progress
}

export interface GnsResult {
  class_name: string
  /** `D` and `none` carry no modality. */
  modality: Modality | null
  region: RegionId
  confidence: number
  probs: Record<string, number>
}

export interface GimResult {
  score: 0 | 1 | 2
  /** IM area as a percentage of the ROI, 0..100. */
  area: number
  /** RGBA PNG at ROI resolution, already tinted. Null when score is 0. */
  mask_url: string | null
}

export interface PolypBox {
  x1: number
  y1: number
  x2: number
  y2: number
  confidence: number
}

/**
 * Gastric polyps: the detector's boxes, and MedSAM's mask for them.
 *
 * The detector proposes boxes, each box prompts MedSAM, and the masks are
 * composited into one RGBA PNG — the same shape of result as `GimResult`, so
 * it draws the same way.
 */
export interface PolypResult {
  /** In ROI pixels, like everything else. Empty when nothing was found. */
  boxes: PolypBox[]
  /** Percentage of the ROI the masks cover, 0..100. */
  area: number
  /** RGBA PNG at ROI resolution, already tinted. Null when nothing was found. */
  mask_url: string | null
}

export interface FrameRecord {
  index: number
  /** Video time in seconds — the only key for aligning with <video>. */
  t: number
  image_url: string
  gns: GnsResult | null
  /** Null on white-light and esophageal frames; GIM is gastric NBI only. */
  gim: GimResult | null
  /**
   * Null unless someone asked for it — the polyp pass is never part of the
   * background scan. Request it with `analyzeFrame(id, t, { polyp: true })`.
   */
  polyp: PolypResult | null
}

export type SessionEvent =
  | { type: 'progress'; session_id: string; progress: Progress }
  | { type: 'status'; session_id: string; status: SessionStatus; error: string | null }
  /** A batch of frames just finished analysis — merge them in as they arrive. */
  | { type: 'frames'; session_id: string; frames: FrameRecord[] }
  | { type: 'ready'; session_id: string; frame_count: number }

export interface VideoFile {
  path: string
  filename: string
  size_bytes: number
}

export interface CgiPair {
  probability: number
  img1: string
  img2: string
  img3: string
}

/** Display order used by both pages, proximal to distal. */
export const REGION_ORDER: RegionId[] = [
  'esophagus',
  'cardia',
  'body',
  'angle',
  'antrum',
  'duodenum',
]

/**
 * Regions GIM is valid on — gastric mucosa only.
 *
 * The model is trained on stomach under NBI; the oesophagus and the duodenum
 * are outside its domain. The gateway's own rule is NBI alone, so a frame
 * there may still carry a `gim` result from the background scan — page 1 does
 * not ask for one and does not show one.
 */
export const GIM_REGIONS: RegionId[] = ['cardia', 'body', 'angle', 'antrum']

/**
 * The site probabilities with the training floor taken out.
 *
 * GNS was trained with label smoothing, which is a way of telling a model not
 * to be certain: a tenth of the probability mass is handed to the wrong
 * classes on purpose. The model learned that, and it shows in every frame —
 * the winner takes about 47% while the other fifteen classes sit in a flat
 * band between 3.4% and 4.1%, no matter what is on screen. Over one
 * procedure's 64,163 frames the top class never once left the range
 * 43.6%–58.7%.
 *
 * That band is not a belief about anatomy. It is a constant the model was
 * trained to emit, and reading it as "the model is only 47% sure" understates
 * a call it makes by a factor of twelve over the runner-up.
 *
 * So the flat part is subtracted and what is left is renormalised: the result
 * is still a distribution summing to one, in the same order, with the same
 * winner — only without the floor. On that same procedure the median top
 * class reads 90% rather than 47%.
 *
 * This is a display transform, not a calibration. Nothing here was fitted to
 * labelled outcomes, because there are none: it removes an artefact whose
 * origin is known, and claims no more than that.
 */
export function withoutSmoothingFloor(
  probs: Record<string, number>,
): Record<string, number> {
  const values = Object.values(probs)
  if (values.length === 0) return probs

  const floor = Math.min(...values)
  const above: Record<string, number> = {}
  let total = 0
  for (const [name, value] of Object.entries(probs)) {
    const residual = value - floor
    above[name] = residual
    total += residual
  }

  // Every class equal — nothing to take out, and nothing to divide by.
  if (total <= 0) return probs

  const scaled: Record<string, number> = {}
  for (const [name, value] of Object.entries(above)) scaled[name] = value / total
  return scaled
}

/** The winning site's share once the training floor is out of the way. */
export function siteConfidence(gns: GnsResult | null | undefined): number | null {
  if (!gns) return null
  const adjusted = withoutSmoothingFloor(gns.probs)
  const value = adjusted[gns.class_name]
  return value === undefined ? gns.confidence : value
}

/** Whether GIM is worth running on a frame GNS classified this way. */
export function gimApplies(gns: GnsResult | null | undefined): boolean {
  return !!gns && gns.modality === 'NBI' && GIM_REGIONS.includes(gns.region)
}

/**
 * Regions the polyp detector is valid on — gastric mucosa under white light.
 *
 * The detector was fine-tuned on the Zhejiang University gastroscopy set,
 * which is white-light stomach throughout. NBI and everything outside the
 * stomach are off its training distribution, so they are not asked for.
 */
export const POLYP_REGIONS: RegionId[] = ['cardia', 'body', 'angle', 'antrum']

/** Whether the polyp pass is worth running on a frame GNS classified this way. */
export function polypApplies(gns: GnsResult | null | undefined): boolean {
  return !!gns && gns.modality === 'WL' && POLYP_REGIONS.includes(gns.region)
}

export const REGION_LABEL: Record<RegionId, string> = {
  esophagus: 'Esophagus',
  cardia: 'Cardia / Fundus',
  body: 'Body',
  angle: 'Angle',
  antrum: 'Antrum',
  duodenum: 'Duodenum',
  unknown: 'Unclassified',
}
