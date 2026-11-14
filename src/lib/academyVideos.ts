// src/lib/academyVideos.ts
//
// The three-part "Complete Guide to Solitaire" video course shown inside
// GRYND Academy. Chapter timestamps come from the rendered parts and are used
// only to seek the <video>; they never re-author the content.

export type AcademyVideoChapter = {
  /** Seconds from the start of the part. */
  at: number;
  title: string;
};

export type AcademyVideo = {
  id: string;
  number: number;
  duration: string;
  lengthSeconds: number;
  title: string;
  summary: string;
  src: string;
  poster: string;
  /** External WebVTT track, generated from the narration manifest. */
  captions: string;
  /** The interactive lesson that practises this part's main idea. */
  lessonId: string;
  chapters: AcademyVideoChapter[];
};

export const ACADEMY_VIDEOS: AcademyVideo[] = [
  {
    id: "part-1",
    number: 1,
    duration: "3:49",
    lengthSeconds: 229,
    title: "Master the Board",
    summary: "The tableau, the stock, and the first moves that actually matter.",
    src: "/videos/academy/part-1.mp4",
    poster: "/videos/academy/part-1-poster.png",
    captions: "/videos/academy/part-1.vtt",
    lessonId: "tableau-basics",
    chapters: [
      { at: 0, title: "Introduction" },
      { at: 48, title: "Understanding the board" },
      { at: 136, title: "How to move cards" },
    ],
  },
  {
    id: "part-2",
    number: 2,
    duration: "4:28",
    lengthSeconds: 268,
    title: "Flip. Stack. Build.",
    summary: "Hidden cards, foundation takebacks and the stock — without guessing.",
    src: "/videos/academy/part-2.mp4",
    poster: "/videos/academy/part-2-poster.png",
    captions: "/videos/academy/part-2.vtt",
    lessonId: "reveal-a-card",
    chapters: [
      { at: 0, title: "Revealing hidden cards" },
      { at: 71, title: "Building the foundations" },
      { at: 146, title: "The stock and waste piles" },
      { at: 220, title: "Putting everything together" },
    ],
  },
  {
    id: "part-3",
    number: 3,
    duration: "4:21",
    lengthSeconds: 261,
    title: "Think Ahead",
    summary: "Read the board, choose the move, and win the GRYND Duel.",
    src: "/videos/academy/part-3.mp4",
    poster: "/videos/academy/part-3-poster.png",
    captions: "/videos/academy/part-3.vtt",
    lessonId: "choosing-sequences",
    chapters: [
      { at: 0, title: "A worked example" },
      { at: 82, title: "How to win, and how GRYND Duels work" },
      { at: 188, title: "Final advice and practice" },
    ],
  },
];

export function academyVideoById(id: string): AcademyVideo | null {
  return ACADEMY_VIDEOS.find((video) => video.id === id) ?? null;
}

export function nextAcademyVideo(id: string): AcademyVideo | null {
  const index = ACADEMY_VIDEOS.findIndex((video) => video.id === id);
  return index >= 0 ? ACADEMY_VIDEOS[index + 1] ?? null : null;
}
