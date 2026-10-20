import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
// Read Unicode cmap tables directly; no additional font-processing dependency.
function glyph(font,code){
  let cmap;
  for(let i=0;i<font.readUInt16BE(4);i++){const p=12+i*16;if(font.toString("ascii",p,p+4)==="cmap")cmap=font.readUInt32BE(p+8);}
  assert.ok(cmap,"Unicode character map exists");
  for(let i=0;i<font.readUInt16BE(cmap+2);i++){
    const p=cmap+4+i*8,platform=font.readUInt16BE(p),encoding=font.readUInt16BE(p+2),offset=cmap+font.readUInt32BE(p+4);
    if(platform!==0&&!(platform===3&&[1,10].includes(encoding)))continue;
    const format=font.readUInt16BE(offset);
    if(format===12){for(let g=0;g<font.readUInt32BE(offset+12);g++){const q=offset+16+g*12,start=font.readUInt32BE(q),end=font.readUInt32BE(q+4);if(code>=start&&code<=end)return font.readUInt32BE(q+8)+code-start;}}
    if(format===4&&code<65536){const n=font.readUInt16BE(offset+6)/2,end=offset+14,start=end+n*2+2,delta=start+n*2,range=delta+n*2;for(let s=0;s<n;s++){if(code<font.readUInt16BE(start+s*2)||code>font.readUInt16BE(end+s*2))continue;const d=font.readInt16BE(delta+s*2),r=font.readUInt16BE(range+s*2);if(!r)return (code+d)&65535;const at=range+s*2+r+(code-font.readUInt16BE(start+s*2))*2,v=font.readUInt16BE(at);return v?(v+d)&65535:0;}}
  }return 0;
}
const characters="歌詞音楽日本語英語眩偉凄腸呼吸扉閉愛美しいんだHello world!0123456789、。！？…ぁぇ";
for(const name of ["NotoSansJP.ttf","NotoSerifJP.ttf","ZenMaruGothic-Medium.ttf","ZenMaruGothic-Bold.ttf"]){const file=await readFile(new URL("../video/fonts/"+name,import.meta.url));for(const char of characters)assert.ok(glyph(file,char.codePointAt(0)),name+" includes "+char);console.log("PASS "+name+": "+[...characters].length+" Japanese/Latin glyphs");}
for(const name of ["OFL.txt","NotoSerifJP-OFL.txt","ZenMaruGothic-OFL.txt"]){const text=await readFile(new URL("../video/fonts/"+name,import.meta.url),"utf8");assert.match(text,/SIL OPEN FONT LICENSE Version 1\.1/);assert.match(text,/Copyright/);console.log("PASS copyright and OFL notice "+name);}
