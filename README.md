# ⏱ Everest Timer — Desktop Widget

Floating always-on-top timer that syncs directly to your Notion Task Tracker database.

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure Notion credentials

Edit `config.json`:

```json
{
  "notionToken": "secret_xxxxxxxxxxxx",
  "notionDatabaseId": "your-database-id-here",
  "fields": {
    "taskName": "Name",
    "startTime": "Start Time",
    "endTime": "End Time",
    "duration": "Duration"
  }
}
```

### 3. Run
```bash
npm start
```

---

## How to get your Notion credentials

### Notion Integration Token
1. Go to https://www.notion.so/profile/integrations
2. Click **New Integration** → name it "Everest Timer"
3. Copy the **Internal Integration Secret** (`secret_xxx...`)
4. Paste into `config.json` as `notionToken`

### Database ID
1. Open your **Tasks Tracker** database in Notion
2. Look at the URL: `notion.so/teameverestngo/XXXXXXXX?v=...`
3. The long ID after `/teameverestngo/` is your Database ID
4. Paste into `config.json` as `notionDatabaseId`

### Connect integration to your DB
1. Open your Notion Tasks Tracker database
2. Click `•••` (top right) → **Connect to** → Select "Everest Timer"

### Add Duration field to Notion (optional)
In your Tasks Tracker DB, add a **Text** field named `Duration`
(or remove `"duration"` from config.json to skip it)

---

## Usage

| Button | Action |
|--------|--------|
| **▶ Start** | Opens task name prompt, then starts timer |
| **■ Stop** | Stops timer, ready to sync |
| **↑** | Pushes entry to Notion (Start Time + End Time + Duration) |

- **Drag** the yellow title bar to move the widget anywhere
- Widget always stays **on top** of all windows
- Press **Enter** in the task name box to start quickly

---

## Build as a standalone Mac app

```bash
npm install
npm run build-mac
```

Output will be in `dist/` as a `.dmg` file you can install permanently.

---

## Field name mismatch?

If your Notion DB uses different field names, update `config.json`:

```json
"fields": {
  "taskName": "Task",          ← match your Notion field exactly
  "startTime": "Started At",
  "endTime": "Ended At",
  "duration": "Time Spent"
}
```
