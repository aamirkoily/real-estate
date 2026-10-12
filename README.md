# HomeMatch AI

An AI-powered real estate recommendation app. Describe the home you want in plain English, and HomeMatch AI turns it into a search, ranks the best homes for you, explains every match with honest pros and cons, and answers follow-up questions in a chat.

AI is provided by [Groq](https://groq.com) (free tier) using the `openai/gpt-oss-120b` model.

## Features

- **Natural-language search**: "3-bed house in Austin under $650k with a yard and good schools" becomes structured filters.
- **AI recommendations**: each home gets a match score, a one-line reason it fits, and pros and cons.
- **Rule-based fallback**: if the AI is rate-limited or offline, you still get scored matches.
- **AI assistant chat**: compare homes, ask about trade-offs, get viewing checklists.
- **Saved homes**: heart a home to keep it (stored in your browser).
- **Monthly cost estimate** on every listing (20% down, 6.5% 30-year fixed, plus HOA).
- Light and dark mode, works on phones.

## Getting started

1. Install [Node.js](https://nodejs.org) 18 or newer. There are no npm packages to install.
2. Create your environment file:
   ```bash
   copy .env.example .env
   ```
   Then open `.env` and paste your Groq API key (get one free at https://console.groq.com/keys).
3. Start the app:
   ```bash
   npm start
   ```
4. Open http://localhost:3000

Use `npm run dev` to auto-restart the server when you edit files.

## Keeping your API key safe

- The key lives only in `.env`, which is listed in `.gitignore`, so it is never committed.
- The key is only used by the server (`src/groq.js`). The browser never sees it.
- The server listens on `127.0.0.1` only, so other devices on your network can't use your quota.
- If a key is ever exposed, revoke it at https://console.groq.com/keys and create a new one.

## Project structure

```
server.js            HTTP server: static files + JSON API
src/
  env.js             tiny .env loader
  errors.js          HttpError (user-safe error messages)
  groq.js            Groq API client (chat + JSON mode)
  listings.js        loads listing data, vocabularies, compact AI descriptions
  recommend.js       scoring, AI ranking, natural-language parsing, chat
data/listings.json   sample listings (30 homes in 5 US cities)
public/
  index.html         page layout
  styles.css         styles (light/dark, responsive)
  app.js             frontend logic
```

## API

| Method | Path             | Body                                   | Returns                                   |
| ------ | ---------------- | -------------------------------------- | ----------------------------------------- |
| GET    | `/api/health`    |                                        | whether AI is configured, model name      |
| GET    | `/api/listings`  |                                        | all listings + cities, types, features    |
| POST   | `/api/parse`     | `{ query }`                            | structured preferences from plain English |
| POST   | `/api/recommend` | preferences                            | ranked homes with AI explanations         |
| POST   | `/api/chat`      | `{ messages, listingIds, prefs }`      | assistant reply                           |

## Notes

- The listings are **sample data** for development. Replace `data/listings.json` with a real feed later; keep the same fields.
- The Groq free tier is limited to about 8,000 tokens per minute, so prompts are kept compact. If you see a "busy" message, wait a few seconds.
- AI output can be wrong. This app is not financial or legal advice.

## Ideas for next steps

- Connect a real listings API
- Map view of results
- User accounts and saved searches
- Mortgage calculator with editable rate and down payment
- Neighborhood insights (crime, amenities, school details)
