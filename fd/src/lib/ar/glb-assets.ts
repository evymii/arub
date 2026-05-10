/** Root-relative URL; file lives in `public/ar/icons/`. */
export const AR_HACK_ICON_GLB_URL = "/ar/icons/hack.glb";

/** Per experience id; add more GLBs under `public/ar/icons/` and map here. */
export const AR_EXPERIENCE_GLB_BY_ID: Record<string, string> = {
  "music-room": AR_HACK_ICON_GLB_URL,
  gallery: AR_HACK_ICON_GLB_URL,
  history: AR_HACK_ICON_GLB_URL,
  media: AR_HACK_ICON_GLB_URL,
  viewpoint: AR_HACK_ICON_GLB_URL,
  archive: AR_HACK_ICON_GLB_URL,
  activity: AR_HACK_ICON_GLB_URL,
};

export function glbUrlForExperienceId(id: string): string {
  return AR_EXPERIENCE_GLB_BY_ID[id] ?? AR_HACK_ICON_GLB_URL;
}
