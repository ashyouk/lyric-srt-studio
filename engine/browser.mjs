import {chromium} from "playwright";
import {existsSync} from "node:fs";
export async function launchBrowser() {
  const options={headless:true};
  const candidates=[process.env.STUDIO_BROWSER,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/chromium", "/usr/bin/google-chrome"];
  const executablePath=candidates.find(p=>p&&existsSync(p));
  if(executablePath) options.executablePath=executablePath;
  return chromium.launch(options);
}
