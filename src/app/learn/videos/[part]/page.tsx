import type { Metadata } from "next";
import { notFound } from "next/navigation";

import VideoLessonPlayer from "../../../../components/learn/VideoLessonPlayer";
import { ACADEMY_VIDEOS, academyVideoById } from "../../../../lib/academyVideos";
import { pageMetadata, DEFAULT_OG_IMAGE } from "../../../../lib/seo";

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

  return pageMetadata({
    title: video.title,
    description: video.summary,
    path: "/learn/videos/" + video.id,
    image: DEFAULT_OG_IMAGE,
    type: "video.other",
  });
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
