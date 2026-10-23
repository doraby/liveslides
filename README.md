# LiveSlides

Listens to your microphone in real time, like a lightweight Granola-style
notetaker, and automatically turns the conversation into a slide deck.

## How it works

1. Tap **Start listening**. Your microphone is recorded in short chunks and
   sent to OpenAI's Whisper for transcription — it works in any spoken
   language automatically, no language needs to be picked. The running
   transcript appears live under the button.
2. Tap the **+** button whenever you want a slide: it summarizes everything
   said since the last slide into a title, 3-5 bullet points, and up to 5
   illustrative photos from Wikimedia Commons — all in the same language
   you're speaking (or a language you pick in Settings). Nothing is generated
   automatically; you're always in control of when a new slide is created.
3. Tap **Stop listening** when you're done. The session saves to your
   browser automatically. Open Settings (⚙️) to download it as **JSON**,
   **PDF**, or **PPTX**, or to revisit past sessions.

The screen itself stays minimal: a preview of the current slide (flip
between past slides via the dots), the Start/Stop and "new slide" buttons
with the live transcript beneath them, and a debug icon + settings gear in
the corner. The debug panel shows a timestamped log of every recording
chunk, transcription, and Claude request — including a warning whenever a
chunk had no detectable microphone signal (so it's clear when the problem is
your mic input rather than transcription itself).

## Requirements

Two API keys of your own, entered in Settings — both stored only in your
browser's `localStorage` and sent directly from your browser to their
respective API, never to any other server:

- **OpenAI API key** (platform.openai.com/api-keys) — for Whisper
  transcription.
- **Anthropic API key** (console.anthropic.com) — for topic detection and
  slide writing.

Works in any modern browser with microphone + `MediaRecorder` support
(Chrome, Edge, Safari, Firefox — desktop or mobile).

## Privacy

This is a static site with no backend. Everything — your API keys, the
transcript, and saved sessions — stays in your browser. The only network
calls are to `api.openai.com` (transcription), `api.anthropic.com`
(topic/summary generation), and `commons.wikimedia.org` (images, no key
required) — each using only your own key.

## Mobile

Add it to your home screen (Share → Add to Home Screen on iOS, or the
browser menu → Add to Home Screen on Android) for an app-like icon.
