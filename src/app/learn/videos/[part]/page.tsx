import type { Metadata } from "next";
import { notFound } from "next/navigation";

import VideoLessonPlayer from "../../../../components/learn/VideoLessonPlayer";
import { ACADEMY_VIDEOS, academyVideoById } from "../../../../lib/academyVideos";

export function generateStaticParams() {
  return ACADEMY_VIDEOS.map((video) => ({ part: video.id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ part: string }>;
}): Promise<Metadata> {
  const { part } = await params;
  const video = academyVideoById(part);
  if (!video) return { title: "Video not found — GRYND Academy" };

  return {
    title: `${video.title} — GRYND Academy`,
    description: video.summary,
    alternates: { canonical: `/learn/videos/${video.id}` },
    openGraph: {
      title: `${video.title} — GRYND Academy`,
      description: video.summary,
      url: `/learn/videos/${video.id}`,
      type: "video.other",
    },
  };
}

export default async function AcademyVideoPage({
  params,
}: {
  params: Promise<{ part: string }>;
}) {
  const { part } = await params;
  const video = academyVideoById(part);
  if (!video) notFound();

  return <VideoLessonPlayer video={video} />;
}
