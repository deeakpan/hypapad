/** Three bars with decreasing width — staircase, not a uniform hamburger. */
export function StaircaseMenuIcon({ className }: { className?: string }) {
  return (
    <svg
      width="22"
      height="18"
      viewBox="0 0 22 18"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <rect x="0" y="1" width="22" height="2.25" rx="1.125" fill="currentColor" />
      <rect x="5" y="7.875" width="17" height="2.25" rx="1.125" fill="currentColor" />
      <rect x="10" y="14.75" width="12" height="2.25" rx="1.125" fill="currentColor" />
    </svg>
  );
}
