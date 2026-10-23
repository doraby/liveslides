# LiveSlides

Listens to a shared tab or screen's audio in real time, like a lightweight
Granola-style notetaker, and automatically turns the conversation into a
slide deck.

## How it works

1. Tap **Start listening**. Your browser asks you to pick a tab, window, or
   screen to share — choose **"Chrome Tab"** (most reliable across
   platforms) or **"Entire Screen"**, and make sure **"Share tab audio" /
   "Share audio"** is checked. That shared audio is recorded in short
   chunks and sent to OpenAI's Whisper for transcription — it works in any
   spoken language automatically. The running transcript appears live under
   the button.
2. Tap the **+** button whenever you want a slide: it summarizes everything
   captured since the last slide into a title, 3-5 bullet points, and up to
   5 illustrative photos from Wikimedia Commons — all in the same language
   being spoken (or a language you pick in Settings). Nothing is generated
   automatically; you're always in control of when a new slide is created.
3. Tap **Stop listening** when you're done (or just stop sharing from the
   browser's own sharing indicator). The session saves to your browser
   automatically. Open Settings (⚙️) to download it as **JSON**, **PDF**, or
   **PPTX**, or to revisit past sessions.

The screen itself stays minimal: a preview of the current slide (flip
between past slides via the dots), the Start/Stop and "new slide" buttons
with the live transcript beneath them, and a debug icon + settings gear in
the corner. The debug panel shows a timestamped log of every recording
chunk, transcription, and Claude request — including a warning whenever a
chunk had no detectable audio (so it's clear when the problem is the audio
source rather than transcription itself).

## Capturing audio: what to pick in the share dialog

Browsers only expose *tab* or *system* audio through the screen/tab-sharing
picker, not through a simple permission prompt - there's no way around that
dialog. For the most reliable audio capture:

- **macOS**: share a **Chrome Tab** specifically. Sharing a window or app
  generally will not offer audio at all on macOS.
- **Windows/ChromeOS**: a Chrome Tab still works best, but "Entire Screen"
  with system audio is also usually available.
- If you don't see a "share audio" checkbox, you're probably sharing a
  window rather than a tab or the whole screen - go back and pick again.

## Requirements

Two API keys of your own, entered in Settings — both stored only in your
browser's `localStorage` and sent directly from your browser to their
respective API, never to any other server:

- **OpenAI API key** (platform.openai.com/api-keys) — for Whisper
  transcription.
- **Anthropic API key** (console.anthropic.com) — for topic detection and
  slide writing.

Needs a Chromium-based browser (Chrome, Edge) for reliable tab-audio
sharing; Safari and Firefox support the underlying APIs much less
consistently for this use case.

## Privacy

This is a static site with no backend. Everything — your API keys, the
transcript, and saved sessions — stays in your browser. The only network
calls are to `api.openai.com` (transcription), `api.anthropic.com`
(topic/summary generation), and `commons.wikimedia.org` (images, no key
required) — each using only your own key.

## Mobile

Add it to your home screen (Share → Add to Home Screen on iOS, or the
browser menu → Add to Home Screen on Android) for an app-like icon. Note
that tab/screen audio sharing is a desktop-browser feature and generally
isn't available on mobile browsers.
