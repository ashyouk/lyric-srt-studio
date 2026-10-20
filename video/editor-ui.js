// Repo-native SVGs. Icons complement short visible names, never replace them.
const paths={
  play:'<path d="m9 5 10 7-10 7z"/>',pause:'<path d="M8 5v14M16 5v14"/>',
  start:'<circle cx="12" cy="12" r="5"/>',end:'<rect x="6" y="6" width="12" height="12" rx="1"/>',
  undo:'<path d="m8 4-5 5 5 5M3 9h10a7 7 0 0 1 0 14"/>',redo:'<path d="m16 4 5 5-5 5M21 9H11a7 7 0 0 0 0 14"/>',
  save:'<path d="M5 3h12l4 4v14H3V3zM7 3v6h10V3M7 21v-8h10v8"/>',
  file:'<path d="M6 2h8l5 5v15H5V2zM14 2v6h5M8 12h8M8 16h8"/>',
  folder:'<path d="M3 7V4h7l3 3h8v13H3zM3 10h18"/>',
  music:'<path d="M9 18V5l11-2v13M9 9l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="17" cy="16" rx="3" ry="2"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 5 2c-2 1-2 2-2 3M12 17h.01"/>',
  guide:'<path d="M3 4h7l2 2 2-2h7v16h-7l-2 2-2-2H3zM12 6v16"/>',
  edit:'<path d="m4 16 12-12 4 4L8 20H4zM13 7l4 4"/>',
  listen:'<path d="M4 14v-3a8 8 0 0 1 16 0v3M4 12h3v8H4zM17 12h3v8h-3z"/>',
  check:'<path d="m5 12 4 4L20 5"/>',next:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
  earlier:'<path d="m9 5-7 7 7 7M2 12h20"/>',later:'<path d="m15 5 7 7-7 7M2 12h20"/>',
  popup:'<rect x="3" y="7" width="14" height="14" rx="1"/><path d="M10 3h11v11M21 3 10 14"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
};
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function controlMarkup(icon,label){
  return `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[icon]||paths.file}</svg><span class="control-label">${escape(label)}</span>`;
}
export function setControl(element,icon,label,description=label){
  if(!element)return;
  const signature=`${icon}:${label}`;
  if(element.dataset.controlSignature!==signature||!element.querySelector('.ui-icon')){
    element.innerHTML=controlMarkup(icon,label);element.dataset.controlSignature=signature;
  }
  element.setAttribute('aria-label',description);element.title=description;
}

export function installEditorGuides(doc=document){
  const storageKey='lyric-srt-browser-guides-v1';
  const guideSelectors=['.intro .eyebrow','.intro>div>p:last-child','.privacy p','#engine-state',
    '.browser-guide>strong','.browser-guide>ol','.browser-guide>.hint','.file-pick>small',
    '#prepare>p.hint:not([id])','#preview-note','#font-note','#output>p:last-child','.edit-help','footer'];
  for(const selector of guideSelectors)doc.querySelectorAll(selector).forEach(el=>el.classList.add('guide-copy'));
  const bar=doc.createElement('div');bar.className='editor-tools';
  bar.innerHTML='<span class="local-badge">素材は端末内のみ</span><button id="guide-toggle" type="button" aria-pressed="false"></button><button id="editor-help-open" type="button"></button>';
  doc.querySelector('header').after(bar);
  const toggle=doc.querySelector('#guide-toggle'),helpButton=doc.querySelector('#editor-help-open');
  let visible=false;try{visible=localStorage.getItem(storageKey)==='on';}catch{}
  function showGuide(value){
    visible=value;doc.body.classList.toggle('guide-visible',visible);
    setControl(toggle,'guide',`ガイド ${visible?'ON':'OFF'}`,visible?'補足説明を隠す':'補足説明を表示する');
    toggle.setAttribute('aria-pressed',String(visible));
    try{localStorage.setItem(storageKey,visible?'on':'off');}catch{}
  }
  toggle.onclick=()=>showGuide(!visible);showGuide(visible);
  setControl(helpButton,'help','使い方','操作説明を開く');
  const dialog=doc.createElement('dialog');dialog.id='editor-help';dialog.className='editor-help';
  dialog.setAttribute('aria-labelledby','editor-help-title');dialog.setAttribute('aria-modal','true');
  dialog.innerHTML=`<div class="help-heading"><h2 id="editor-help-title" tabindex="-1">使い方</h2><button id="editor-help-close" type="button">${controlMarkup('close','閉じる')}</button></div>
    <ol class="help-steps"><li><strong>${controlMarkup('folder','作業を開く')}</strong><p>PCで同期済みの場合は、保存したプロジェクトJSONを開きます。続けて同じ音源を、この端末から選んでください。</p></li>
    <li><strong>${controlMarkup('listen','聴いて修正')}</strong><p>「修正」タブで行番号を押すと、その行の少し手前へ移動します。「試聴」で再生し、「−0.1秒／＋0.1秒」で行全体を動かします。開始・終了を個別に直すこともできます。</p></li>
    <li><strong>${controlMarkup('check','確認する')}</strong><p>聴いて問題がなければ、行の「確認」を押します。修正後は再び要確認になります。「戻る／やり直す」で操作を取り消せます。</p></li>
    <li><strong>${controlMarkup('save','保存する')}</strong><p>「作業保存」は続きを編集するJSON、「SRT保存」は確認済み行だけの字幕です。音源はJSONに含まれないため、再読込後は選び直します。ブラウザの自動保存だけに頼らずJSONも保存してください。</p></li></ol>
    <details><summary>新しく手動で作るには？</summary><p>音源を選び、歌詞を貼り付けて「反映」を押します。「修正」で行を選び、再生位置を合わせて固定ボタンの「開始」「終了」で記録します。その後、聴いて「確認」を押します。</p></details>
    <details><summary>アイコンと表示について</summary><p>○ 開始：いまの位置を選択行の開始へ記録。□ 終了：終了へ記録。↶ 戻る／↷ やり直す：編集履歴。選択している行と再生中の行は別々に表示されます。「ガイド ON」で画面内の補足説明も読めます。</p></details>
    <details><summary>できること・できないこと</summary><p>この画面は端末内での再生・時刻修正・保存・SRT出力用です。自動同期とMP4作成はPC版で行います。SRTにはフォント・色・配置は入りません。音源や歌詞は外部送信しませんが、画面や同梱フォントの読み込みには通信が必要です。</p><p>音源はMP3・M4A・WAV、動画はH.264 MP4を想定し、再生可否と保存先はブラウザに依存します。iPhone／iPad実機は引き続き確認中です。<a href="fonts/README.md" target="_blank" rel="noopener">フォントとライセンス</a></p></details>`;
  doc.body.append(dialog);
  function close(){if(typeof dialog.close==='function')dialog.close();else{dialog.removeAttribute('open');helpButton.focus({preventScroll:true});}}
  helpButton.onclick=()=>{if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');doc.querySelector('#editor-help-title').focus({preventScroll:true});};
  doc.querySelector('#editor-help-close').onclick=close;
  dialog.addEventListener('close',()=>helpButton.focus({preventScroll:true}));
  dialog.addEventListener('click',event=>{if(event.target===dialog)close();});
  dialog.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();close();}
    if(event.key==='Tab'){
      const controls=[...dialog.querySelectorAll('button,a[href],summary')].filter(el=>el.getClientRects().length);
      const first=controls[0],last=controls.at(-1);
      if(event.shiftKey&&(doc.activeElement===first||doc.activeElement.id==='editor-help-title')){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&doc.activeElement===last){event.preventDefault();first?.focus();}
    }
  });
  // Preserve the native file input and its change handler while shortening labels.
  for(const [id,icon,label,description] of [
    ['browser-project-file','folder','作業を開く','PC版またはこの画面で保存したプロジェクトJSONを開く'],
    ['project-file','folder','作業を開く','プロジェクトJSONを開く'],
    ['media-file','music','音源・動画','端末から音源または動画を選ぶ'],
    ['audio-file','music','別音源（任意）','動画に合わせる別の音源を選ぶ'],
    ['background-file','file','背景（任意）','プレビューの背景画像を選ぶ']]){
    const input=doc.getElementById(id),labelElement=input.parentElement;
    [...labelElement.childNodes].filter(node=>node.nodeType===3).forEach(node=>node.remove());
    const heading=doc.createElement('span');heading.className='file-label';heading.innerHTML=controlMarkup(icon,label);labelElement.prepend(heading);
    input.setAttribute('aria-label',description);labelElement.title=description;
    if(labelElement.classList.contains('file-button')){labelElement.tabIndex=0;labelElement.setAttribute('role','button');labelElement.setAttribute('aria-label',description);labelElement.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();input.click();}};}
  }
  const samples=doc.getElementById('font-samples'),details=doc.createElement('details');
  details.className='font-sample-disclosure';const summary=doc.createElement('summary');summary.textContent='書体サンプル';details.append(summary);samples.before(details);details.append(samples);
  return {get visible(){return visible;}};
}
