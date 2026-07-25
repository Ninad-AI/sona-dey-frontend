import Image from "next/image";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sona Dey | Model & Influencer",
  description: "Sona Dey — model and influencer portfolio",
};

export default function SonaPage() {
  return (
    <div className="flex flex-col flex-1 items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex flex-1 w-full max-w-5xl flex-col items-center gap-12 py-24 px-8">
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start sm:gap-12">
          <Image
            src="/sona.jpg"
            alt="Sona Dey"
            width={320}
            height={400}
            className="rounded-2xl object-cover shadow-lg"
            priority
          />
          <div className="flex max-w-lg flex-col gap-4 text-center sm:text-left">
            <h1 className="text-4xl font-bold tracking-tight text-black dark:text-zinc-50">
              Sona Dey
            </h1>
            <p className="text-xl text-zinc-500 dark:text-zinc-400">
              Model &middot; Influencer
            </p>
            <p className="text-base leading-7 text-zinc-600 dark:text-zinc-400">
              Welcome to my corner of the web. I&apos;m a model and content
              creator passionate about fashion, lifestyle, and connecting with
              people through authentic storytelling.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
