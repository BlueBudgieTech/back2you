## Run
1. Install Node.js, then in this folder: `npm install`
2. Copy `.env.example` to `.env` and set `GEMINI_API_KEY` (optional: without it the site works with basic matching and no photo AI).
3. `npm start` and open http://localhost:3000 (do not open the HTML file directly).

Demo accounts: `report` / `123` and `find` / `123`, or sign up. Use two browsers/profiles to try a claim end to end.

## How it fits together
- `public/index.html` — the whole UI (single file), talks to the server through `/api/...`
- `server.js` — login, sessions, photo analysis (`/api/analyze-item`), static hosting of `public/` only
- `store.js` — reports, claims, approvals, private finder contact (`/api/store/...`, `/api/ai/match`); data saved to `data/store.json`
- A finder's contact details are only released to the claimant after the finder approves.

Demo-only: passwords are plain text in `data/users.json` and sessions are in memory. 

## Note
The api key to gemma is removed, as per GitHub guidelines. (For testing, use AQ.Ab8RN6JHe2cNJdInq5BpoVWN2dMV8NIW4-OYW2Lvmvu71IXocw)
