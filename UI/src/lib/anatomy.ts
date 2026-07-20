// Single source of truth for turning a GNS class code into an anatomical region.
//
// The SGAFormer paper and the GNS code label the six gastric sections only as
// opaque G1–G6, with no documented anatomy; the paper confirms the class
// structure (1 esophagus + 6 gastric + 1 duodenum + none, WL and NBI for
// esophageal/gastric sections only) but not what each Gk is. So the anatomy is
// fixed empirically, from a confusion matrix of GNS argmax vs the physicians'
// timeline annotations over both procedures (18,650 annotated frames). Each
// section is anchored by its NBI class, which is the cleanest signal (NBI is
// used for deliberate close observation, so it carries far less pass-through
// contamination than the white-light class):
//
//   G1_NBI antrum 87%    G2_NBI antrum 96%    G3_NBI body 76%
//   G4_NBI body 86%      G5_NBI angle 87%     G6_NBI proximal 88%
//   D duodenum 63%       E_NBI esophagus 75%
//
// G6 is the retroflexed proximal view the model does not split into cardia vs
// fundus, so both share one region.

export type Region = 'esophagus' | 'proximal' | 'body' | 'angle' | 'antrum' | 'duodenum'

export const REGION_OF_CLASS: Record<string, Region> = {
  E_WL: 'esophagus',
  E_NBI: 'esophagus',
  G6_WL: 'proximal',
  G6_NBI: 'proximal',
  G3_WL: 'body',
  G3_NBI: 'body',
  G4_WL: 'body',
  G4_NBI: 'body',
  G5_WL: 'angle',
  G5_NBI: 'angle',
  // G1 is the antrum: G1_NBI is 87% antrum. G1_WL alone is muddy (esophagus 29%
  // / antrum 26% / angle 21%), but it is the same section as G1_NBI, and the
  // model's own hard-negative map clusters G1/G2/D — the distal stomach by the
  // pylorus. (An earlier single-video read mistook G1_WL for the angle.)
  G1_WL: 'antrum',
  G1_NBI: 'antrum',
  G2_WL: 'antrum',
  G2_NBI: 'antrum',
  D: 'duodenum',
}

// Positions along the endoscope's path (mouth → duodenum). The scope can only
// move station-by-station, which is what the transition prior in smoothing.ts
// leans on. `none` (throat/mouth, outside the tract) sits before the esophagus.
export const REGION_ORDER: Record<Region, number> = {
  esophagus: 1,
  proximal: 2,
  body: 3,
  angle: 4,
  antrum: 5,
  duodenum: 6,
}

export const ORDINAL_OF_CLASS: Record<string, number> = Object.fromEntries(
  Object.entries(REGION_OF_CLASS).map(([cls, region]) => [cls, REGION_ORDER[region]]),
)
ORDINAL_OF_CLASS.none = 0

export const REGION_LABEL: Record<Region, string> = {
  esophagus: '食道',
  proximal: '賁門 / 胃底',
  body: '胃體',
  angle: '胃角',
  antrum: '胃竇',
  duodenum: '十二指腸',
}

export function regionOfClass(cls: string | null | undefined): Region | null {
  if (!cls) return null
  return REGION_OF_CLASS[cls] ?? null
}

// Human anatomical name for a class, or null for classes with no tract region
// (e.g. `none` = throat/mouth, outside the stomach).
export function partNameOfClass(cls: string | null | undefined): string | null {
  const region = regionOfClass(cls)
  return region ? REGION_LABEL[region] : null
}
