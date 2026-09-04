# LiveSlides

Listens to your microphone in real time, like a lightweight Granola-style
notetaker, and automatically turns the conversation into a slide deck.

## How it works

1. Click **Start listening**. Your browser transcribes speech from your
   microphone continuously (via the Web Speech API — no audio is uploaded
   anywhere for transcription).
2. After about 30 seconds, the first slide is generated from whatever's been
   said so far.
3. Every 2 minutes after that, the new transcript since the last check is
   sent to Claude to decide whether the topic has changed. If it has, a new
   slide is created: a title, 3-5 bullet points, and 4-5 illustrative photos
   pulled from Wikimedia Commons.
4. Click **Stop listening** when you're done. The session is saved to your
   browser's local storage automatically, and you can download it as
   **JSON**, **PDF**, or **PPTX**.

## Requirements

- **Chrome or Edge** (desktop or Android). Speech recognition is not
  reliably supported in Safari/iOS.
- Your own **Anthropic API key** (console.anthropic.com), entered in
  Settings (⚙️). It's stored only in your browser's `localStorage` and sent
  directly from your browser to `api.anthropic.com` — never to any other
  server.

## Privacy

This is a static site with no backend. Everything — your API key, the
transcript, and saved sessions — stays in your browser. The only network
calls are to `api.anthropic.com` (for topic/summary generation, using your
own key) and `commons.wikimedia.org` (for images, no key required).

## Mobile

Add it to your home screen (Share → Add to Home Screen on iOS, or the
browser menu → Add to Home Screen on Android) for an app-like icon. Note the
Safari/iOS limitation above — for reliable listening, use Chrome on Android
or a desktop browser.
