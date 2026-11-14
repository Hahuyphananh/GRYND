"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconClock,
  IconList,
  IconPlayerPlay,
  IconRefresh,
  IconSchool,
} from "@tabler/icons-react";

import Footer from "../Footer";
import NavigationBar from "../navigation-bar";
import { useAcademyVideoProgress } from "../../hooks/useAcademyVideoProgress";
import { useTranslation } from "../../hooks/useTranslation";
import {
  academyVideoPercent,
  academyVideoResumeAt,
  academyVideoStatus,
} from "../../lib/academyVideoProgress";
import { nextAcademyVideo, type AcademyVideo } from "../../lib/academyVideos";
import { lessonById } from "../../lib/solitaire-duel/lessonCatalog";

function clock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Persist at most this often while playing (seconds of playback). */
const SAVE_EVERY_SECONDS = 5;

/**
 * One part of the video course. The <video> is the single source of playback —
 * chapters only seek it — and progress is written locally so the cards can
 * offer "Resume" the next time.
 */
export default function VideoLessonPlayer({ video }: { video: AcademyVideo }) {
  const { t } = useTranslation();
  const playerRef = useRef<HTMLVideoElement>(null);
  const [activeChapter, setActiveChapter] = useState(0);
  const [resumedAt, setResumedAt] = useState<number | null>(null);
  const [livePercent, setLivePercent] = useState<number | null>(null);
  const lastSavedAt = useRef(0);
  const didResume = useRef(false);
  const { progress, isHydrated, recordPosition, markWatched } =
    useAcademyVideoProgress();
  const next = nextAcademyVideo(video.id);
  const lesson = lessonById(video.lessonId);
  const status = academyVideoStatus(progress, video);
  const percent = livePercent ?? academyVideoPercent(progress, video);

  // Resume once, as soon as the stored record is available and the media knows
  // its duration. Never fight the browser: only seek if playback is at 0.
  useEffect(() => {
    if (!isHydrated || didResume.current) return;
    const element = playerRef.current;
    if (!element) return;

    const resume = academyVideoResumeAt(progress, video);
    didResume.current = true;
    if (resume === null) return;

    const apply = () => {
      if (element.currentTime > 1) return;
      element.currentTime = resume;
      lastSavedAt.current = resume;
      setResumedAt(resume);
    };
    if (element.readyState >= 1) apply();
    else element.addEventListener("loadedmetadata", apply, { once: true });
  }, [isHydrated, progress, video]);

  const seek = (at: number) => {
    const element = playerRef.current;
    if (!element) return;
    element.currentTime = at;
    setResumedAt(null);
    void element.play();
  };

  const startOver = () => {
    const element = playerRef.current;
    if (!element) return;
    element.currentTime = 0;
    lastSavedAt.current = 0;
    setResumedAt(null);
    setLivePercent(0);
    recordPosition(video.id, 0);
    void element.play();
  };

  const handleTimeUpdate = () => {
    const element = playerRef.current;
    if (!element) return;
    const time = element.currentTime;

    const index = video.chapters.reduce(
      (current, chapter, chapterIndex) =>
        time >= chapter.at ? chapterIndex : current,
      0,
    );
    setActiveChapter((previous) => (previous === index ? previous : index));

    if (element.duration > 0) {
      const nextPercent = Math.min(
        100,
        Math.round((time / element.duration) * 100),
      );
      setLivePercent((previous) =>
        previous === nextPercent ? previous : nextPercent,
      );
    }

    if (Math.abs(time - lastSavedAt.current) >= SAVE_EVERY_SECONDS) {
      lastSavedAt.current = time;
      recordPosition(video.id, time);
    }
  };

  const handlePause = () => {
    const element = playerRef.current;
    if (!element || element.ended) return;
    lastSavedAt.current = element.currentTime;
    recordPosition(video.id, element.currentTime);
  };

  const handleEnded = () => {
    const element = playerRef.current;
    markWatched(video.id, element?.currentTime ?? video.lengthSeconds);
    setLivePercent(100);
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#040712] pb-24 text-white md:pb-0">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[560px] bg-[radial-gradient(ellipse_at_top,rgba(0,229,255,0.14),transparent_62%)]"
      />

      <NavigationBar currentPath="/learn" />

      <main className="relative mx-auto max-w-5xl px-4 pt-24 sm:px-6 md:pt-28">
        <Link
          href="/learn"
          className="inline-flex items-center gap-2 text-xs font-bold text-white/55 underline-offset-4 transition hover:text-white hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
        >
          <IconArrowLeft size={15} aria-hidden="true" />
          {t("learn.videos.back")}
        </Link>

        <div className="mt-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-[#00e5ff]/75">
              {t("learn.videos.kicker")} · {t("learn.videos.part", { number: video.number })}
            </p>
            <h1 className="mt-1 text-3xl font-black leading-[1.02] tracking-tight sm:text-4xl">
              {video.title}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/60">
              {video.summary}
            </p>
          </div>
          {status === "watched" && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[#00ffa3]/30 bg-[#00ffa3]/10 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.18em] text-[#8dffd0]">
              <IconCheck size={12} aria-hidden="true" />
              {t("learn.videos.watched")}
            </span>
          )}
        </div>

        <div className="mt-5 overflow-hidden rounded-2xl border border-white/10 bg-black shadow-[0_30px_80px_rgba(0,0,0,0.45)]">
          <video
            ref={playerRef}
            className="aspect-video w-full"
            controls
            playsInline
            preload="metadata"
            poster={video.poster}
            onTimeUpdate={handleTimeUpdate}
            onPause={handlePause}
            onEnded={handleEnded}
          >
            <source src={video.src} type="video/mp4" />
            <track
              kind="subtitles"
              src={video.captions}
              srcLang="en"
              label="English"
              default
            />
            {t("learn.videos.unsupported")}
          </video>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={t("learn.videos.progress")}
            className="h-1 w-full bg-white/10"
          >
            <div
              className="h-full bg-gradient-to-r from-[#00e5ff] to-[#00ffa3] transition-[width] duration-300 motion-reduce:transition-none"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>

        {resumedAt !== null && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#00e5ff]/25 bg-[#00e5ff]/[0.06] px-3 py-2">
            <p className="text-xs font-semibold text-[#9dd8ff]">
              {t("learn.videos.resumedAt", { time: clock(resumedAt) })}
            </p>
            <button
              type="button"
              onClick={startOver}
              className="inline-flex items-center gap-1.5 text-xs font-extrabold text-[#00e5ff] underline-offset-4 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
            >
              <IconRefresh size={13} aria-hidden="true" />
              {t("learn.videos.startOver")}
            </button>
          </div>
        )}

        <div className="mt-5 grid gap-4 md:grid-cols-[minmax(0,1fr)_300px]">
          <div className="rounded-2xl border border-white/10 bg-[#071128]/80 p-4">
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold text-[#9dd8ff]/80">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1">
                <IconClock size={12} aria-hidden="true" />
                {video.duration}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1">
                <IconPlayerPlay size={12} aria-hidden="true" />
                {t("learn.videos.part", { number: video.number })}
              </span>
              {status !== "not-started" && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1">
                  {percent}%
                </span>
              )}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-white/45">
              {t("learn.videos.note")}
            </p>
          </div>

          <aside
            aria-label={t("learn.videos.chapters")}
            className="rounded-2xl border border-white/10 bg-[#071128]/80 p-4"
          >
            <p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.22em] text-[#00e5ff]/75">
              <IconList size={14} aria-hidden="true" />
              {t("learn.videos.chapters")}
            </p>
            <ol className="mt-3 space-y-1">
              {video.chapters.map((chapter, index) => (
                <li key={chapter.at}>
                  <button
                    type="button"
                    onClick={() => seek(chapter.at)}
                    aria-current={index === activeChapter ? "true" : undefined}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-semibold transition ${
                      index === activeChapter
                        ? "bg-[#00e5ff]/10 text-[#9dd8ff]"
                        : "text-white/55 hover:bg-white/5 hover:text-white"
                    }`}
                  >
                    <span className="w-8 shrink-0 font-mono text-[10px] text-white/40">
                      {clock(chapter.at)}
                    </span>
                    <span>{chapter.title}</span>
                  </button>
                </li>
              ))}
            </ol>
          </aside>
        </div>

        {lesson ? (
          <Link
            href={`/learn/${lesson.id}`}
            data-testid="video-practice-lesson"
            className="mt-4 flex flex-col gap-3 rounded-2xl border border-[#00ffa3]/25 bg-[#00ffa3]/[0.05] p-4 transition hover:bg-[#00ffa3]/[0.09] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00ffa3] sm:flex-row sm:items-center sm:justify-between"
          >
            <span className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#00ffa3]/15 text-[#8dffd0]">
                <IconSchool size={20} aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block text-[10px] font-black uppercase tracking-[0.24em] text-[#8dffd0]/70">
                  {t("learn.videos.practiceKicker")}
                </span>
                <span className="mt-1 block text-base font-extrabold text-white">
                  {t(lesson.titleKey)}
                </span>
                <span className="mt-1 block max-w-xl text-xs leading-relaxed text-white/50">
                  {t(lesson.descriptionKey)}
                </span>
                <span className="mt-2 flex flex-wrap items-center gap-2 text-[11px] font-semibold text-white/40">
                  <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[#9dd8ff]">
                    {t(`learn.difficulty.${lesson.difficulty}`)}
                  </span>
                  {t("learn.lesson.minutes", { minutes: lesson.estimatedMinutes })}
                </span>
              </span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1.5 text-sm font-extrabold text-[#00ffa3]">
              {t("learn.videos.practiceCta")}
              <IconArrowRight size={16} aria-hidden="true" />
            </span>
          </Link>
        ) : null}

        {next ? (
          <Link
            href={`/learn/videos/${next.id}`}
            className="mt-4 flex items-center justify-between gap-4 rounded-2xl border border-[#00e5ff]/25 bg-[#00e5ff]/[0.06] p-4 transition hover:bg-[#00e5ff]/[0.1] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
          >
            <span>
              <span className="block text-[10px] font-black uppercase tracking-[0.24em] text-[#9dd8ff]/70">
                {t("learn.videos.next")}
              </span>
              <span className="mt-1 block text-base font-extrabold text-white">
                {next.title}
              </span>
            </span>
            <IconArrowRight size={20} className="shrink-0 text-[#00e5ff]" aria-hidden="true" />
          </Link>
        ) : (
          <Link
            href="/learn"
            className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[#00e5ff] px-5 text-sm font-black text-[#00212b] transition hover:brightness-110 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
          >
            {t("learn.videos.back")}
            <IconArrowRight size={16} aria-hidden="true" />
          </Link>
        )}
      </main>

      <Footer />
    </div>
  );
}
