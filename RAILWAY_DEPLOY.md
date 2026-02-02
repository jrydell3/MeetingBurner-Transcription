# Railway Deployment Guide - MeetingBurner Transcription Service

## Quick Start

1. **Create New Railway Project**
   - Go to https://railway.app/dashboard
   - Click "New Project"
   - Select "Deploy from GitHub repo"
   - Choose `jrydell3/MeetingBurner-Transcription`

2. **Configure Environment Variables**

   Navigate to the service settings and add these variables:

   ```
   LIVEKIT_URL=wss://meetingburner-tmi96u14.livekit.cloud
   LIVEKIT_API_KEY=APIXwHJu5sqzBzZ
   LIVEKIT_API_SECRET=5oTJmfShhWEXmZrilBAERvSFKb28bu3mjpkAP7f8fhJB
   ASSEMBLYAI_API_KEY=f9f2102dc54843d0b1d67ac737ea1ba9
   SUPABASE_URL=https://saiaeosfltqvcxiqzusx.supabase.co
   SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNhaWFlb3NmbHRxdmN4aXF6dXN4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTUwODE3NCwiZXhwIjoyMDg1MDg0MTc0fQ.3kDynRjI99CGe74zqSZvAWvPoN7LsOCPuc8RVq09tdQ
   NODE_ENV=production
   ```

   **Note:** Do NOT set PORT - Railway sets this automatically via the `$PORT` variable.

3. **Deploy**
   - Railway will automatically deploy on push to main
   - Wait for the deployment to complete
   - Check the deployment logs for any errors

4. **Verify Deployment**

   Once deployed, get the public URL (e.g., `https://meetingburner-transcription-production.up.railway.app`)

   Test the health endpoint:
   ```bash
   curl https://YOUR-RAILWAY-URL/health
   ```

   Expected response:
   ```json
   {
     "status": "healthy",
     "activeRooms": 0,
     "uptime": 123
   }
   ```

5. **Update MeetingBurner Environment Variables**

   Add the Railway URL to your Vercel deployment:

   ```bash
   vercel env add TRANSCRIPTION_SERVICE_URL
   # Enter: https://YOUR-RAILWAY-URL (without trailing slash)
   ```

## Endpoints

- `GET /health` - Health check
- `GET /rooms` - List active transcription rooms
- `POST /rooms/:roomId/start` - Start transcription for a room
- `POST /rooms/:roomId/stop` - Stop transcription for a room
- `POST /webhook/livekit` - LiveKit webhook handler
- `POST /webhook/meetingburner` - MeetingBurner webhook handler

## Architecture

```
MeetingBurner (Vercel)
  ↓ creates room
LiveKit Cloud (meetingburner-tmi96u14.livekit.cloud)
  ↓ webhook (room_started)
Transcription Service (Railway)
  ↓ joins room as bot
  ↓ captures per-speaker audio
  ↓ applies VAD (voice activity detection)
  ↓ sends to AssemblyAI Streaming STT
AssemblyAI
  ↓ returns transcriptions
Transcription Service
  ↓ stores in Supabase
Supabase Realtime
  ↓ broadcasts to subscribed clients
JR Agent (Railway) & Frontend (Vercel)
  ↓ receives transcripts
  ↓ processes/displays
```

## Troubleshooting

### Deployment fails with "Port already in use"
- Do NOT set the PORT environment variable
- Railway manages this automatically

### Health check fails
- Check that the service is running: `railway logs`
- Verify the health endpoint returns 200 OK
- Check for errors in the startup logs

### AssemblyAI connection errors
- Verify ASSEMBLYAI_API_KEY is set correctly
- Check AssemblyAI dashboard for quota/usage
- Ensure API key has Streaming STT access

### LiveKit connection errors
- Verify LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET are correct
- Check LiveKit dashboard for room status
- Ensure the bot has permission to join rooms

### Supabase connection errors
- Verify SUPABASE_URL and SUPABASE_SERVICE_KEY
- Check Supabase project is active
- Ensure `live_transcript_events` table exists

## Monitoring

Check Railway logs for activity:
```bash
railway logs
```

Monitor active transcription sessions:
```bash
curl https://YOUR-RAILWAY-URL/rooms
```

## Cost Estimates

- **Railway**: ~$5-20/month (depends on usage)
- **AssemblyAI**: ~$0.00025/second of audio (~$0.015/minute)
- **LiveKit**: Included in existing MeetingBurner LiveKit plan
