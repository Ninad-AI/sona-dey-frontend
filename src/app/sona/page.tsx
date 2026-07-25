import Image from "next/image";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sona Dey | Model & Influencer",
  description: "Sona Dey — model and influencer portfolio",
};

export default function SonaPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-6xl flex-col items-center gap-16 px-6 pt-32 pb-24 md:flex-row md:items-center md:gap-16 md:px-12">
        <div className="relative w-64 shrink-0 md:w-80">
          <div
            className="overflow-hidden shadow-2xl"
            style={{ borderRadius: "30% 70% 70% 30% / 30% 30% 70% 70%" }}
          >
            <Image
              src="/sona-1.png"
              alt="Sona Dey"
              width={320}
              height={569}
              className="object-cover"
              priority
            />
            <div className="absolute inset-0 bg-linear-to-t from-black/40 via-transparent to-transparent opacity-60" />
          </div>
        </div>
        <div className="flex max-w-lg flex-col items-center gap-5 text-center md:items-start md:text-left">
          <p className="text-sm font-bold tracking-[0.2em] uppercase text-rose-400">
            &bull; Model &amp; Influencer
          </p>
          <h1 className="text-5xl font-black tracking-tighter text-black md:text-7xl dark:text-zinc-50">
            Sona Dey
          </h1>
          <p className="text-base leading-7 text-zinc-600 dark:text-zinc-400">
            Welcome to my corner of the web. I&apos;m a model and content
            creator passionate about fashion, lifestyle, and connecting with
            people through authentic storytelling.
          </p>
        </div>
      </main>
    </div>
  );
}
