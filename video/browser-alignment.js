// Match canonical lyrics to real ASR word intervals. Never divide song duration.
export const BROWSER_MODEL='onnx-community/whisper-tiny_timestamped';
export const MODEL_REVISION='517244293732ee2d58139af5814231b7e6830a0d';
export const BROWSER_MODELS=Object.freeze({tiny:{id:BROWSER_MODEL,revision:MODEL_REVISION},base:{id:'onnx-community/whisper-base_timestamped',revision:'608c49e61301901684bc36cac8f74b95ff6b5a8e'},small:{id:'onnx-community/whisper-small_timestamped',revision:'65caa70f294b46e1c33ff820aae6b16d048ab818'}});
export const normalizeMatch=text=>Array.from(String(text).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,''));

export function matchAcousticWords(lines,chunks,duration){
  if(!Number.isFinite(duration)||duration<=0||duration>300)throw new Error('解析は5分以内の音源で試してください。');
  const ranges=[],input=[];
  for(const line of lines){const chars=normalizeMatch(line.alignmentText||line.text);ranges.push([input.length,input.length+chars.length]);input.push(...chars);}
  const heard=[],spans=[];
  for(const chunk of chunks||[]){
    const [start,end]=chunk.timestamp||[];
    if(typeof start!=='number'||typeof end!=='number'||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>duration+.15)continue;
    for(const c of normalizeMatch(chunk.text)){heard.push(c);spans.push([start,Math.min(end,duration)]);}
  }
  // Anchor on longest contiguous phrases before matching the gaps. A plain LCS
  // can scatter a short recognized verse across similar characters much later.
  const n=input.length,m=heard.length;
  if((n+1)*(m+1)>24_000_000)throw new Error('歌詞が長すぎます。短い区間で試してください。');
  const positions=new Map();heard.forEach((c,j)=>{if(!positions.has(c))positions.set(c,[]);positions.get(c).push(j);});
  const matches=new Map(),stack=[[0,n,0,m]];let operations=0;
  while(stack.length){
    const [lo,hi,left,right]=stack.pop();let previous=new Map(),best=0,a=lo,b=left;
    for(let i=lo;i<hi;i++){
      const current=new Map();
      for(const j of positions.get(input[i])||[]){
        if(j<left)continue;if(j>=right)break;
        if(++operations>48_000_000)throw new Error('照合量が多すぎます。短い歌詞で試してください。');
        const size=(previous.get(j-1)||0)+1;current.set(j,size);
        if(size>best){best=size;a=i-size+1;b=j-size+1;}
      }
      previous=current;
    }
    if(!best)continue;
    for(let k=0;k<best;k++)matches.set(a+k,b+k);
    if(lo<a&&left<b)stack.push([lo,a,left,b]);
    if(a+best<hi&&b+best<right)stack.push([a+best,hi,b+best,right]);
  }
  let previousEnd=0;
  return lines.map((line,index)=>{
    const [left,right]=ranges[index],found=[];for(let p=left;p<right;p++)if(matches.has(p))found.push(spans[matches.get(p)]);
    const coverage=found.length/Math.max(1,right-left),start=found.length?Math.min(...found.map(s=>s[0])):null,end=found.length?Math.max(...found.map(s=>s[1])):null;
    const edges=matches.has(left)&&matches.has(right-1);
    const valid=found.length>0&&coverage>=.6&&start<end&&(edges||end-start>=.5);
    const reasons=['端末内の軽量音声認識による候補です。必ず聴いて確認してください。'];
    if(!valid)reasons.push('十分な音響時刻との対応がなく、未配置にしました。歌詞の読み・認識漏れ・未歌唱を確認してください。');
    if(!edges&&found.length)reasons.push('行の先頭または末尾に一致がなく、境界は部分候補です。');
    if(coverage<1)reasons.push('照合用文字の一部が認識結果と一致しません。');
    if(valid&&start<previousEnd)reasons.push('前行との重なりがあります。繰り返し・重唱・境界を確認してください。');
    if(valid&&end-start>16)reasons.push('長い区間です。間奏を含んでいないか確認してください。');
    if(lines.some((other,i)=>i!==index&&normalizeMatch(other.alignmentText||other.text).join('')===input.slice(left,right).join('')))reasons.push('同じ歌詞の繰り返しです。どの回に対応したか確認してください。');
    if(valid)previousEnd=end;
    return {id:line.id,start:valid?Math.round(start*1000)/1000:null,end:valid?Math.round(end*1000)/1000:null,
      candidateStart:start,candidateEnd:end,review:true,reasons,
      evidence:{matchedCharacters:found.length,inputCharacters:right-left,startCharacterMatched:matches.has(left),endCharacterMatched:matches.has(right-1)}};
  });
}
