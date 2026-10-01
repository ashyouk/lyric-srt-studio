// Read the renderer's PNG directly. Browser screenshots wait for compositor frames;
// export needs only this canvas at the explicit media timestamp, including alpha.
export async function captureFrame(page, project, time) {
  const png = await page.evaluate(async ({project, time}) => {
    await window.prepareFrame(project);
    window.drawFrame(project, time);
    return document.querySelector("canvas").toDataURL("image/png").split(",")[1];
  }, {project, time});
  return Buffer.from(png, "base64");
}
