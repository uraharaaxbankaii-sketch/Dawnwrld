import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import YTDlpWrap from "yt-dlp-wrap";

dotenv.config();

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const ytdlp = new YTDlpWrap(
    process.env.YTDLP_PATH || "yt-dlp"
);

const uploadsDir = path.join(process.cwd(), "uploads");
const clipsDir = path.join(process.cwd(), "clips");

fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(clipsDir, { recursive: true });

app.use(express.json());
app.use(express.static("public"));
app.use("/clips", express.static(clipsDir));

const storage = multer.diskStorage({
    destination: uploadsDir,

    filename: (req, file, cb) => {
        cb(
            null,
            `${Date.now()}-${file.originalname.replace(
                /[^a-zA-Z0-9.-]/g,
                "_"
            )}`
        );
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: 500 * 1024 * 1024
    }
});


async function processVideo(videoPath) {

    const baseName = path.parse(videoPath).name;

    const audioPath = path.join(
        uploadsDir,
        `${baseName}.mp3`
    );

    console.log("Extracting audio...");

    await execFileAsync("ffmpeg", [
        "-y",
        "-i",
        videoPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "64k",
        audioPath
    ]);


    console.log("Transcribing...");

    const transcription =
        await openai.audio.transcriptions.create({
            file: fs.createReadStream(audioPath),
            model: "whisper-1",
            response_format: "verbose_json",
            timestamp_granularities: ["segment"]
        });

    const segments = transcription.segments || [];

    if (!segments.length) {
        throw new Error(
            "No spoken content was detected."
        );
    }


    const transcript = segments
        .map((s, i) => `
SEGMENT ${i}
START: ${s.start}
END: ${s.end}
TEXT: ${s.text}
`)
        .join("\n");


    console.log("Finding best clips...");

    const prompt = `
You are an expert short-form video editor.

Find the 5 BEST moments in this video.

Choose moments with:
- strong hooks
- surprising statements
- funny moments
- emotional moments
- useful information
- interesting stories
- high energy
- satisfying conclusions

Avoid:
- greetings
- advertisements
- boring sections
- incomplete thoughts
- moments needing missing context

Each clip should preferably be
20 to 60 seconds long.

Use timestamps from the transcript.

Return ONLY JSON:

{
  "clips": [
    {
      "start": 10,
      "end": 40,
      "title": "Short title",
      "reason": "Why this moment is interesting"
    }
  ]
}

Return up to 5 clips.

TRANSCRIPT:

${transcript}
`;


    const response =
        await openai.responses.create({
            model: "gpt-5-mini",
            input: prompt
        });


    let text = response.output_text
        .trim()
        .replace(/^```json/i, "")
        .replace(/^```/i, "")
        .replace(/```$/i, "")
        .trim();


    const aiResult = JSON.parse(text);

    const clips = [];


    for (
        let i = 0;
        i < aiResult.clips.length;
        i++
    ) {

        let start =
            Number(aiResult.clips[i].start);

        let end =
            Number(aiResult.clips[i].end);

        if (
            !Number.isFinite(start) ||
            !Number.isFinite(end)
        ) {
            continue;
        }


        start = Math.max(
            0,
            start - 1.5
        );

        end += 1.5;


        if (end - start > 65) {
            end = start + 65;
        }


        const filename =
            `clip-${Date.now()}-${i + 1}.mp4`;

        const output =
            path.join(
                clipsDir,
                filename
            );


        console.log(
            `Creating clip ${i + 1}...`
        );


        await execFileAsync("ffmpeg", [
            "-y",
            "-ss",
            String(start),
            "-i",
            videoPath,
            "-t",
            String(end - start),
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            output
        ]);


        clips.push({
            number: i + 1,
            title: aiResult.clips[i].title,
            reason: aiResult.clips[i].reason,
            start,
            end,
            url: `/clips/${filename}`
        });
    }


    try {
        fs.unlinkSync(audioPath);
    } catch {}


    return clips;
}


/*
====================================================
YOUTUBE URL
====================================================
*/

app.post(
    "/api/youtube",
    async (req, res) => {

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


            const filename =
                `youtube-${Date.now()}.mp4`;

            videoPath =
                path.join(
                    uploadsDir,
                    filename
                );


            console.log(
                "Downloading permitted YouTube video..."
            );


            await ytdlp.execPromise([
                url,

                "-f",
                "bv*+ba/b",

                "--merge-output-format",
                "mp4",

                "-o",
                videoPath
            ]);


            console.log(
                "YouTube video downloaded."
            );


            const clips =
                await processVideo(
                    videoPath
                );


            try {
                fs.unlinkSync(videoPath);
            } catch {}


            res.json({
                success: true,
                clips
            });


        } catch (error) {

            console.error(error);

            if (videoPath) {
                try {
                    fs.unlinkSync(videoPath);
                } catch {}
            }


            res.status(500).json({
                error:
                    error.message ||
                    "YouTube processing failed."
            });
        }
    }
);


/*
====================================================
VIDEO UPLOAD
====================================================
*/

app.post(
    "/api/upload",
    upload.single("video"),
    async (req, res) => {

        if (!req.file) {
            return res.status(400).json({
                error: "Please upload a video."
            });
        }


        try {

            const clips =
                await processVideo(
                    req.file.path
                );


            try {
                fs.unlinkSync(
                    req.file.path
                );
            } catch {}


            res.json({
                success: true,
                clips
            });


        } catch (error) {

            console.error(error);

            try {
                fs.unlinkSync(
                    req.file.path
                );
            } catch {}


            res.status(500).json({
                error:
                    error.message ||
                    "Video processing failed."
            });
        }
    }
);


app.listen(PORT, () => {

    console.log(
        `AI ClipMaster running at http://localhost:${PORT}`
    );
});
