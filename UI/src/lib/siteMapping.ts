import type { GnsResult } from '../types'

export type CgiSite = 'A' | 'B' | 'C'

// GNS's G1–G6 stations carry no documented anatomy anywhere in the model code,
// so this mapping was derived empirically: 556 frames sampled from the
// annotated segments of two real procedures were run through GNS and
// cross-tabulated against the physician's own timeline. Purity per class,
// video1 / video2:
//
//   G2_WL -> antrum   79% / 72%          G3_WL -> corpus  89% / 100%
//   G4_WL -> corpus   81% /  87%         G6_WL -> cardia  21% /  86%
//
// G1_WL is deliberately absent: although the G1 section is the antrum (its NBI
// class is 87% antrum), the white-light G1_WL prediction alone is too muddy to
// trust for CGI (esophagus 29% / antrum 26% / angle 21% across both procedures),
// so only G2_WL feeds the antrum bay.
//
// G6 covers the retroflexed proximal-stomach view, which the model does not
// split into cardia vs fundus — video1 spent longer on the fundus, which is why
// its cardia purity is lower. Picks here are a starting point; the physician
// confirms or overrides them.
//
// White-light classes only: CGI's normalisation statistics (mean R .587 /
// G .332 / B .271) match white-light mucosa, and NBI frames are far
// off-distribution for it.
export const SITE_OF_CLASS: Record<string, CgiSite> = {
  G2_WL: 'A',
  G3_WL: 'B',
  G4_WL: 'B',
  G6_WL: 'C',
}

export function siteOfClass(gns: GnsResult | undefined): CgiSite | null {
  if (!gns) return null
  return SITE_OF_CLASS[gns.class_name] ?? null
}
