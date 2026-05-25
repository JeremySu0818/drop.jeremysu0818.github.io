# PicDrop

GitHub Pages static frontend plus a Render-hosted API for one-time encrypted image transfer.

## Structure

```text
.
├── index.html
├── static
│   ├── css
│   ├── images
│   └── js
└── server
```

## Security Model

- The browser generates a high-entropy `SHA-256:` share code.
- AES-GCM encryption and decryption happen only in the browser.
- The server receives a SHA-256 lookup hash and encrypted ciphertext.
- The server deletes the encrypted payload after the first download request.
- Undownloaded payloads expire after 30 minutes.

SHA-256 is collision-resistant, not mathematically zero-collision. This implementation uses 256-bit browser randomness plus SHA-256 lookup/key derivation, which makes accidental collision practically infeasible.

## Local Run

Start the API:

```bash
cd server
npm install
npm run dev
```

Open `index.html` or serve this folder as a static site. The frontend defaults to `https://picdrop-server.jeremytw.qzz.io`.
