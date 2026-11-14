"use client";

import Image from "next/image";
import Link from "next/link";
import {
  IconArrowRight,
  IconCheck,
  IconClock,
  IconPlayerPlay,
} from "@tabler/icons-react";

import { useAcademyVideoProgress } from "../../hooks/useAcademyVideoProgress";
import { useTranslation } from "../../hooks/useTranslation";
import {
  academyVideoPercent,
  academyVideoResumeAt,
  academyVideoStatus,
  watchedVideoCount,
} from "../../lib/academyVideoProgress";
import { ACADEMY_VIDEOS } from "../../lib/academyVideos";

function clock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The video course, surfaced at the top of GRYND Academy. Each card links to
 * its own player page and reflects local watch progress; the interactive
 * lesson path stays the primary action.
 */
export default function AcademyVideoSection() {
  const { t } = useTranslation();
  const { progress } = useAcademyVideoProgress();
  const watched = watchedVideoCount(progress);

  return (
    <section className="mt-10" aria-labelledby="learn-videos-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.3em] text-[#00e5ff]/75">
            {t("learn.videos.kicker")}
          </p>
          <h2 id="learn-videos-title" className="mt-1 text-2xl font-black tracking-tight">
            {t("learn.videos.title")}
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-white/50">
            {t("learn.videos.description")}
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-white/40">
          <IconPlayerPlay size={14} aria-hidden="true" />
          {t("learn.videos.watchedCount", {
            watched,
            total: ACADEMY_VIDEOS.length,
          })}
        </span>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-3">
        {ACADEMY_VIDEOS.map((video) => {
          const status = academyVideoStatus(progress, video);
          const resume = academyVideoResumeAt(progress, video);
          const percent = academyVideoPercent(progress, video);
          const action =
            status === "watched"
              ? t("learn.videos.watchAgain")
              : resume !== null
                ? t("learn.videos.resume", { time: clock(resume) })
                : t("learn.videos.watch");

          return (
            <Link
              key={video.id}
              href={`/learn/videos/${video.id}`}
              data-testid="learn-video-card"
              data-video-id={video.id}
              data-status={status}
              className="group flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#071128]/80 transition hover:border-[#00e5ff]/35 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
            >
              <div className="relative aspect-video overflow-hidden bg-black">
                <Image
                  src={video.poster}
                  alt=""
                  fill
                  sizes="(min-width: 768px) 33vw, 100vw"
                  className="object-cover transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none"
                />
                <span className="absolute inset-0 bg-gradient-to-t from-[#040712]/80 via-transparent to-transparent" />
                <span className="absolute left-3 top-3 rounded-full border border-white/15 bg-black/55 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.16em] text-white/80 backdrop-blur">
                  {t("learn.videos.part", { number: video.number })}
                </span>
                {status === "watched" && (
                  <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full bg-[#00ffa3]/15 px-2 py-1 text-[10px] font-bold text-[#8dffd0] backdrop-blur">
                    <IconCheck size={11} aria-hidden="true" />
                    {t("learn.videos.watched")}
                  </span>
                )}
                <span className="absolute bottom-3 right-3 inline-flex items-center gap-1 rounded-full bg-black/65 px-2 py-1 text-[10px] font-bold text-white/85 backdrop-blur">
                  <IconClock size={11} aria-hidden="true" />
                  {video.duration}
                </span>
                <span className="absolute bottom-3 left-3 flex h-10 w-10 items-center justify-center rounded-full bg-[#00e5ff] text-[#00212b] shadow-lg shadow-[#00e5ff]/30">
                  <IconPlayerPlay size={18} aria-hidden="true" />
                </span>
                {status !== "not-started" && (
                  <span className="absolute inset-x-0 bottom-0 h-1 bg-white/15">
                    <span
                      className="block h-full bg-gradient-to-r from-[#00e5ff] to-[#00ffa3]"
                      style={{ width: `${percent}%` }}
                    />
                  </span>
                )}
              </div>

              <div className="flex flex-1 flex-col p-4">
                <h3 className="text-base font-extrabold leading-snug text-white">
                  {video.title}
                </h3>
                <p className="mt-1.5 flex-1 text-xs leading-relaxed text-white/50">
                  {video.summary}
                </p>
                <span className="mt-3 inline-flex items-center gap-1.5 text-xs font-extrabold text-[#00e5ff]">
                  {action}
                  <IconArrowRight size={14} aria-hidden="true" />
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
