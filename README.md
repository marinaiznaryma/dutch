# Words — flashcard PWA

An installable web app for memorising vocabulary with spaced repetition — with Kiko the rocking horse cheering you on, streaks, XP, daily goals, combos, sounds and confetti.
Words come from a Google Sheet, so you add words by editing the sheet and every device picks them up.

No build step, no dependencies: plain HTML/CSS/JS.

## 1. Set up the word sheet

1. Create a Google Sheet (or import `words-template.csv` via File → Import).
2. First row is the header: `word`, `translation`, and optionally `example`, `deck`.
   (Unrecognised header names fall back to column order: A = word, B = translation, C = example, D = deck.)
   You can put several blocks side by side, separated by an empty column (e.g. verbs in A–D, nouns in F–I); each block needs its own header row.
3. Share → General access → **Anyone with the link** → Viewer. Copy the link.

To use several tabs, open the tab you want and copy the link (it contains `#gid=…`).

## 2. Host it (HTTPS is required for installing on iPhone)

Pick one:

- **Netlify Drop** (fastest): go to https://app.netlify.com/drop and drag this folder in. You get an `https://….netlify.app` URL.
- **GitHub Pages**: push this folder to a repo → Settings → Pages → deploy from branch `main`, root folder.
- **Cloudflare Pages**: same idea, drag-and-drop upload.

Anything that serves static files over HTTPS works.

## 3. Install on each iPhone / iPad

1. Open the URL in **Safari**.
2. Share button → **Add to Home Screen**.
3. Open it from the home screen → Settings tab → paste the sheet link → **Save & sync**.

It also works on Android (Chrome → Install app) and desktop browsers.

## How it works

- **Adding words**: edit the sheet. The app re-syncs on launch, when it returns to the foreground (if >5 min since last sync), or when you tap the sync button. Words are cached so studying works offline.
- **Scheduling**: simplified SM-2. Again / Hard / Good / Easy; the button shows the next interval. "Again" brings the card back a few cards later. A word with an interval ≥ 21 days counts as mastered.
- **New words per day** is configurable; "Learn 10 more" on the done screen raises today's limit.
- **Grammar → De or het?**: rounds of 10 nouns from the `noun` deck (words written with their article, e.g. `het kind`). Pick the article; missed nouns come back at the end of the round and more often in later rounds. Keyboard: `d` / `h`, Enter to continue.
- **Decks**: if the `deck` column is filled, a picker appears on the Study tab.
- **Pronunciation**: uses the device's built-in text-to-speech; pick the language in Settings.
- **Progress** is stored per device (localStorage). Move it with Settings → Export / Import (merges, keeping the most recent review of each word).
  Renaming a word or its deck in the sheet makes it a new card.

## Updating the app

Re-deploy the folder. The service worker is network-first, so devices get the new version the next time they open the app online.

## Local testing

```
npx serve .
```
Then open http://localhost:3000. (Over plain HTTP from another device the app runs, but offline mode/install need HTTPS.)

## Credits

The mascot's silhouette is traced from the "Rocking horse" icon on Flaticon
(https://www.flaticon.com/free-icon/rocking-horse_61333, source file `icons/61333.png`).
Flaticon's free licence requires attribution to the icon's author.
