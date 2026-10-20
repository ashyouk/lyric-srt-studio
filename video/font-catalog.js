// Only bundled fonts are offered: the same bytes are used in every renderer.
export const FONTS = Object.freeze([
  {id:"noto-sans", family:"Studio Noto", label:"Noto Sans JP · ゴシック", japanese:true},
  {id:"noto-serif", family:"Studio Serif", label:"Noto Serif JP · 明朝", japanese:true},
  {id:"zen-maru", family:"Studio Rounded", label:"Zen Maru Gothic · 丸ゴシック", japanese:true}
]);
export const normalizeFont = id => FONTS.some(f=>f.id===id) ? id : FONTS[0].id;
export const fontFamily = id => FONTS.find(f=>f.id===normalizeFont(id)).family;
