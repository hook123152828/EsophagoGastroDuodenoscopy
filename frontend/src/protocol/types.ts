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

export interface FrameRecord {
  index: number
  /** Video time in seconds — the only key for aligning with <video>. */
  t: number
  image_url: string
  gns: GnsResult | null
  /** Always null on white-light frames: GIM is trained on NBI only. */
  gim: GimResult | null
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

export interface GutCoreEvidence {
  frame_index: number
  t: number
  image_url: string
  region: RegionId
  /** Relative gated-attention weight among all submitted examination images. */
  contribution: number
}

export interface GutCoreResult {
  prediction: 'cancer' | 'non-cancer'
  /** Uncalibrated softmax model output; this is not absolute clinical risk. */
  cancer_score: number
  threshold: number
  score_is_calibrated: false
  research_only: true
  image_count: number
  recommended_minimum: number
  warning: string | null
  input_frame_indices: number[]
  evidence: GutCoreEvidence[]
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

export const REGION_LABEL: Record<RegionId, string> = {
  esophagus: 'Esophagus',
  cardia: 'Cardia / Fundus',
  body: 'Body',
  angle: 'Angle',
  antrum: 'Antrum',
  duodenum: 'Duodenum',
  unknown: 'Unclassified',
}
