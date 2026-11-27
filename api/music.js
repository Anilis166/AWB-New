// /api/music.js — Vercel Serverless Function
// R2 presigned URL generator for music player
// GET ?action=list  → return playlist
// GET ?action=url&key=xxx → return presigned URL (1 hour)

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const BUCKET = process.env.R2_BUCKET;
const ACCESS_KEY = process.env.R2_ACCESS_KEY_ID;
const SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");
}

const PLAYLIST = [
  { title: "FEFE", artist: "6ix9ine ft. Nicki Minaj", key: "6ix9ine - FEFE ft. Nicki Minaj Murda Beatz.mp3" },
  { title: "I Like It", artist: "Cardi B, Bad Bunny, J Balvin", key: "Cardi B Bad Bunny & J Balvin - I Like It [Official Music Video].mp3" },
  { title: "Coming In Hot", artist: "Lecrae & Andy Mineo", key: "Lecrae_Andy_Mineo_-_Coming_In_Hot.mp3" },
  { title: "PRESSURE!", artist: "Unknown", key: "PRESSURE!.mp3" },
  { title: "Shaka Boom", artist: "Method Man Remix", key: "Shaka boom ( method man se acabo remix )viral song Shaka boom ringtone.mp3" },
  { title: "Taste", artist: "Tyga ft. Offset", key: "Tyga_-_Taste_Official_Video_ft._Offset.mp3" },
  { title: "SHOP", artist: "Zorro", key: "Zorro - SHOP.mp3" },
];

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const { action, key } = req.query;

  if (action === "list") {
    return res.status(200).json(PLAYLIST);
  }

  if (action === "url" && key) {
    if (!ACCOUNT_ID || !BUCKET || !ACCESS_KEY || !SECRET_KEY) {
      return res.status(503).json({ error: "R2 storage is not configured" });
    }
    try {
      const s3 = new S3Client({
        region: "auto",
        endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
      });
      const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
      const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
      return res.status(200).json({ url });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: "Missing action (list|url) and/or key" });
}
