import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
const exec = promisify(execFile);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const PORT = process.env.PORT || 3000;

const downloads = path.join(process.cwd(), "downloads");
const clips = path.join(process.cwd(), "clips");

fs.mkdirSync(downloads, { recursive: true });
fs.mkdirSync(clips, { recursive: true });

app.use(express.json());
app.use(express.static("public"));
app.use("/clips", express.static(clips));

app.post("/api/clip", async (req, res) => {
  let videoPath = null;

  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        error: "Please enter a YouTube URL."
      });
    }

    if (
      !url.includes("youtube.com") &&
      !url.includes("youtu.be")
    ) {
      return res.status(400).json({
        error: "Please enter a valid YouTube URL."
      });
    }

    const id = Date.now();

    videoPath = path.join(downloads, `${id}.mp4`);
    const audioPath = path.join(downloads, `${id}.mp3`);

    // Download YouTube video
    await exec("yt-dlp", [
      "-f",
      "best[ext=mp4]/best",
      "--merge-output-format",
      "mp4",
      "-o",
      videoPath,
      url
    ]);

    // Extract audio
    await exec("ffmpeg", [
      "-y",
      "-i",
      videoPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      audioPath
    ]);

    // Transcribe
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: "gpt-4o-mini-transcribe"
    });

    const transcript = transcription.text;

    if (!transcript || transcript.length < 20) {
      throw new Error("Could not get enough speech from the video.");
    }

    // Find best moments
    const response = await openai.responses.create({
      model: "gpt-5.6-luna",
      input: `
You are an expert short-form video editor.

Analyze this transcript and find the 5 best moments for YouTube Shorts,
Instagram Reels or TikTok.

Choose moments that are:
- interesting
- funny
- surprising
- emotional
- informative
- high-energy
- likely to keep viewers watching

Return ONLY valid JSON in this format:

{
  "clips": [
    {
      "start": 0,
      "end": 30,
      "title": "Short title",
      "reason": "Why this moment is good"
    }
  ]
}

Rules:
- Maximum 5 clips
- Each clip should be 15-60 seconds
- Do not create overlapping clips
- Start and end must be seconds from the transcript
- Use only moments actually present in the transcript

TRANSCRIPT:
${transcript}
`
    });

    let result;

    try {
      result = JSON.parse(response.output_text);
    } catch {
      throw new Error("AI returned an invalid clip selection.");
    }

    const finalClips = [];

    for (let i = 0; i < result.clips.length; i++) {
      const clip = result.clips[i];

      const start = Math.max(0, Number(clip.start));
      const end = Math.max(start + 15, Number(clip.end));

      const filename = `${id}-clip-${i + 1}.mp4`;
      const outputPath = path.join(clips, filename);

      await exec("ffmpeg", [
        "-y",
        "-ss",
        String(start),
        "-i",
        videoPath,
        "-t",
        String(end - start),
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        outputPath
      ]);

      finalClips.push({
        title: clip.title,
        reason: clip.reason,
        start,
        end,
        url: `/clips/${filename}`
      });
    }

    fs.rmSync(videoPath, { force: true });
    fs.rmSync(audioPath, { force: true });

    res.json({
      success: true,
      clips: finalClips
    });

  } catch (error) {
    console.error(error);

    if (videoPath) {
      fs.rmSync(videoPath, { force: true });
    }

    res.status(500).json({
      error: error.message || "Something went wrong."
    });
  }
});

app.listen(PORT, () => {
  console.log(`Dawnwrld running on port ${PORT}`);
});
