# Drop

> Secure Encrypted File Sharing

Drop is a lightweight, zero-knowledge, end-to-end encrypted file sharing web application.

## Features
- **Any File Type**: Share documents, archives, images, videos, or any file format.
- **Client-Side Encryption**: Files are encrypted in your browser using AES-GCM before upload.
- **One-Time Download**: Server copies are destroyed immediately after download or upon expiration (30 minutes).
- **No Account Required**: Instant drag & drop sharing with a 64-character decryption code.
- **Short Secure Links**: Uploads produce a direct `r/#…` link containing a random 22-character Base62 token. The browser hashes that token into the same 64-character decryption code, and the token stays out of server requests.
- **Safe Receiver Page**: The compact receiver page checks availability before enabling download, without starting a download or consuming the file. It uses the same resumable streaming flow and destroys the server copy only after a successful save.
