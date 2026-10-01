# 歌詞入り動画試作：方式選定と境界

調査・実装日：2026-10-01。新ブランチのみ。公開手動β版の置換ではありません。

## 採用方式

PC内で **faster-whisper small（CPU int8）で実際の単語時刻を探し、その付近をQwen3-ForcedAligner-0.6B-hfで行ごとに強制照合** します。音声認識を表示歌詞には使いません。文字列の単調照合で入力行へ実音響時刻を対応させます。処理時間／全文の長さから均等な時刻を生成する処理はありません。

全文を一度に強制照合した実験では、歌唱で数秒ずれる行があったため不採用。ASRの実音響アンカーがない行は未配置にし、独立した認識内容との一致が不足する行も未確定です。行の周辺±0.65秒だけを強制照合し、境界差が大きい場合はASR時刻へ戻して理由を記録します。無音端は実波形の10ms RMSで調整します。このRMS処理は静かな音源向けの補助で、伴奏から歌声を分離するものではありません。

表示本文は原文、`alignmentText` は読み／照合用。NFKC・記号除去は照合だけに使います。入力の空行・[Verse]等は原文に残し、字幕区間にはしません。同じ行の繰り返しは別IDのまま扱います。

診断にある `asrCharacterAgreement` は「正規化した照合文字のうち、独立ASRと単調一致した割合」であり、歌唱時刻の正確率ではありません。UIでは信頼度%と表示せず、一致文字数と確認理由を表示します。すべての自動結果は要確認です。手動修正が一端でもある行は再解析で区間全体を保護します。

## 公式資料による比較

|方式|日本語・歌唱との関係|実行・負荷／今回の実測|費用・ライセンス／判断|
|---|---|---|---|
|Qwen3 forced aligner＋Whisper|公式に日本語・英語を含む11言語の強制照合。歌唱精度の保証はない。別ASR併用の公式例がある|Python／PyTorch。CPU可。本試作の125.68秒の歌唱で約68〜104秒（取得済みモデル、他処理の負荷で変動）|公開モデルApache-2.0、Whisper系MIT。利用の従量料金なし。採用|
|faster-whisper単語時刻|多言語ASRの文字と入力歌詞を対応。認識漏れ・繰り返し・歌唱の長音で境界が曖昧|Python／CTranslate2、CPU int8。同音源の単語時刻取得約26.4秒|コード・変換済みWhisperモデルMIT。軽量の選択肢として搭載|
|WhisperX|ASR＋言語別wav2vec2/CTC照合。日本語設定あり。伴奏・重唱への保証なし|PyTorch、言語別モデル追加。今回は速度・精度未測定|本体BSD-2-Clause、追加モデルは個別ライセンス。依存・モデル組合せを増やさないため今回未採用|
|stable-ts|Whisperで利用者のテキストを照合。多言語。歌唱／伴奏の難しさに関する公開課題あり|Python／Whisper。今回未測定|MITだが公式リポジトリはアーカイブ済み。新開発の主方式にはしない|
|Montreal Forced Aligner|発音辞書＋音響モデルの強制照合。日本語辞書・読みの整備が必要。歌唱は別検証が必要|Kaldi系のローカル環境。今回未測定|本体MIT、辞書・モデルは別条件。Windows試作で環境と辞書の負担が増えるため未採用|
|MMS系CTC照合|多言語。日本語の分割・ローマ字化等が必要な構成あり|PyTorch。今回未測定。torchaudioの従来FA APIは廃止方向|代表モデルmms-1b-allはCC-BY-NC-4.0。販売用途にそのまま採用しない|
|ブラウザだけの推論|モデル／WebGPUの実装次第。iPhoneで同等の処理を保証できない|今回未実測。メモリ・モデル配信・長尺MP4出力に制約|方式を実証してから検討。UIを先に完成品と呼ばない|

出典（公式）：[Qwenモデルと使用例](https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B-hf)、[Qwen公式実装](https://github.com/QwenLM/Qwen3-ASR)、[faster-whisper](https://github.com/SYSTRAN/faster-whisper)、[smallモデル](https://huggingface.co/Systran/faster-whisper-small)、[Whisper](https://github.com/openai/whisper)、[WhisperX](https://github.com/m-bain/whisperX)、[stable-ts](https://github.com/jianfch/stable-ts)、[MFA](https://github.com/MontrealCorpusTools/Montreal-Forced-Aligner)、[MMSモデル](https://huggingface.co/facebook/mms-1b-all)、[torchaudio公式FA案内](https://docs.pytorch.org/audio/2.8/tutorials/forced_alignment_for_multilingual_data_tutorial.html)。未実測の候補に速度・精度の数字を割り当てていません。

歌声分離は追加していません。現段階で精度向上を実測できておらず、PC負荷を増やす根拠がないためです。課金API・新しい音源送信先もありません。

## Web UIと動画出力

ブラウザ → 同じ起動PCのFastAPI → 別プロセスの同期／動画処理。素材と処理結果はPCの `.studio-data/` に保存します。既定は127.0.0.1のみ。LANは明示的な起動と起動ごとのアクセス文字列が必要です。外部Originを拒否し、静的配信は画面用ファイルだけに限定します。APIから任意のファイルパス／FFmpegフィルター／外部URLは受け付けません。本番用の認証・TLS・レート制限・マルチユーザー環境ではありません。

プレビューと書き出しは `video/core.js` の同じ `layoutScene`／`drawLyrics`。描画時刻はプレビューではメディア時刻、出力では `frame/30`。RAF間隔を足し合わせないため、シークや低速エンコードでスクロール位置が変わりません。各行の折り返し高さからスクロール位置を計算し、歌っていない区間では全行を薄くします。前後の行は上下端へ向かって薄く表示。通常字幕は半開区間 `[start,end)` の外で消えます。

出力は共通canvasを透過PNGとしてFFmpegへ渡す、固定フレーム時刻のオフライン処理です。画面録画ではありません。素材の映像はそのままの速度でスケール＋パディング、音声ストリームは1本だけを選択。別音源なら元音声は混ぜません。実際の先頭PTSの空白は同期・合成とも `aresample=async=1:first_pts=0` で維持します。複雑な編集リスト／特殊PTS・VFR素材の網羅検証はしていません。

プロジェクト `lyric-video-studio-project` version 1に入力原文、自動候補、手動区間、確認状態、スタイル、素材参照を保存します。旧形式を変更せず、取り込み先に旧JSONの複製を持ちます。素材は埋め込みません。ブラウザの保存キーも手動版とは別です。

## ライセンスと販売前の注意

|使用物|条件（今回のインストール／公式配布）|
|---|---|
|Qwen3-ForcedAligner-0.6B-hf|Apache-2.0。モデルを再配布する場合もライセンス・通知を保持|
|faster-whisper / Whisper small / CTranslate2|MIT。著作権・許諾文を保持|
|Transformers / Accelerate / python-multipart|Apache-2.0|
|PyTorch 2.14.1|複合ライセンス：Apache-2.0、LLVM例外、BSD-2/3、BSL-1.0、MIT。wheelに含まれる各通知を保持|
|SoundFile / PyAV / Uvicorn|BSD-3-Clause。音声ライブラリ・FFmpegのバイナリ条件は別途確認|
|librosa|ISC|
|nagisa / FastAPI / truststore|MIT|
|Playwright|Apache-2.0。使用ブラウザ本体はその配布条件に従う|
|Noto Sans JP|SIL OFL-1.1。公式Google Fonts配布の未改変フォントとOFL.txtを同梱|
|FFmpeg / libx264|今回の外部FFmpegビルドはGPLv3構成。リポジトリにはバイナリを同梱しない。販売用インストーラーへ同梱する場合はソース提供・通知等を設計する必要あり|

フォント：[公式配布](https://github.com/google/fonts/tree/main/ofl/notosansjp)、FFmpeg：[公式ライセンス説明](https://ffmpeg.org/legal.html)。オープンなライセンスは商用利用を一律禁止しませんが、販売パッケージの同梱物・ライセンス表示・コーデックの特許条件・入力作品の権利は別途確認が必要です。この試作だけで販売可否の法的保証はしません。Windows音声合成は言語経路のテストだけで、アプリの同期や出力では使いません。

モデル／Python環境／node_modules／ユーザー素材／生成動画はGitに含めません。無料ローカル推論以外の方法へ切り替える場合は、送信先・目的・費用を示して利用者の承認を得ます。
