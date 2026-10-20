import {drawLyrics} from "./core.js";
// A visual mirror only. Sources belong to the parent and are never played here.
export function drawComposite(ctx, overlay, project, time, source) {
  ctx.fillStyle=project.style.background;ctx.fillRect(0,0,1920,1080);
  if(source) {
    const w=source.videoWidth||source.naturalWidth, h=source.videoHeight||source.naturalHeight;
    if(w&&h) {const scale=Math.min(1920/w,1080/h);ctx.drawImage(source,(1920-w*scale)/2,(1080-h*scale)/2,w*scale,h*scale);}
  }
  drawLyrics(overlay,project,time);ctx.drawImage(overlay.canvas,0,0);
}
