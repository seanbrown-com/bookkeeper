# Bookkeeper

Bookkeeper is a local-first personal finance app for importing transactions, syncing read-only SimpleFIN data, and viewing account balances and month-ahead recurring cashflow.

## Run

```bash
npm install
npm start
```

Open `http://localhost:8000`.

On first launch, create the local login. The login password unlocks the encrypted local data key.

## Features

- Local login required before API access.
- SQLite data store at `data/bookkeeper.sqlite`.
- Sensitive account metadata, transaction payloads, and SimpleFIN Access URLs are encrypted with AES-256-GCM before storage.
- SimpleFIN setup tokens are managed from Settings.
- SimpleFIN refreshes are saved locally and skipped if refreshed recently.
- CSV/XLSX imports use a preview/confirm workflow with duplicate detection.
- The existing workbook format is detected as account blocks across row 1/row 2.
- Accounts can be color coded.
- Dark/light mode with a green theme.
- View All paginates 100 transactions at a time and auto-loads near the bottom.
- Month Ahead detects monthly recurring transactions from at least 3 months of history and remembers rejected guesses.

## Configuration

```env
SIMPLEFIN_DAYS=30
SIMPLEFIN_PENDING=true
PORT=8000
```

Bookkeeper stores runtime data in `data/`, which is gitignored. Back up `data/bookkeeper.sqlite` if you care about keeping imported history.

## Security Notes

This is local-first application-level encryption, not SQLCipher. SQLite table names and some indexing metadata remain visible, but transaction details, account metadata, and SimpleFIN Access URLs are encrypted before storage. After a server restart, log in again to unlock the data key.
