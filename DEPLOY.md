# Deploy

Cloud Run target:

1. Build and deploy the container.
2. Set environment variables:
   - `WEBHOOK_SHARED_SECRET`
   - `PIPELINE_ID`
   - `DEFAULT_PIPELINE_ADAPTER`
   - `PIPELINES_CONFIG_PATH`
   - `GOOGLE_SHEETS_SPREADSHEET_ID`
   - `GOOGLE_SHEETS_TAB_NAME`
   - `GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT` if the platform stores the service account as a secret value
   - `EMAIL_ADMIN_TOKEN`
   - `BREVO_API_KEY` (new, rotated key only)
   - `BREVO_SENDER_EMAIL` (verified Brevo sender)
   - `BREVO_SENDER_NAME`
3. Prefer attached service account identity on Cloud Run.
   - Do not set `GOOGLE_SERVICE_ACCOUNT_JSON` in production unless you must.
4. Expose `/webhooks/gravity-forms` to the WordPress plugin.
5. Use `/healthz` for a basic health check.

Local run:

```bash
python3 app.py
```

Production container entrypoint:

```bash
gunicorn --bind 0.0.0.0:8080 --workers 2 --threads 4 app:app
```
