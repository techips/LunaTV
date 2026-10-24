import { Heart } from 'lucide-react';

/** 收藏图标（播放页、直播页共用） */
export default function FavoriteIcon({
  filled,
  sizeClass = 'h-6 w-6',
}: {
  filled: boolean;
  sizeClass?: string;
}) {
  if (filled) {
    return (
      <svg className={sizeClass} viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'>
        <path
          d='M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'
          fill='#ef4444'
          stroke='#ef4444'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
        />
      </svg>
    );
  }
  return <Heart className={`${sizeClass} stroke-[1] text-gray-600 dark:text-gray-300`} />;
}
