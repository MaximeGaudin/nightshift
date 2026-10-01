// Reproduces docs/logo/logo.svg; favicon in src/web/index.html and README image must follow.
export function Logo({ size, className }: { size: number; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false" className={className}>
      <path d="M12.5 2.5A7 7 0 1 0 12.5 13.5A5.5 5.5 0 1 1 12.5 2.5Z" fill="#5e6ad2" />
      <path d="M10 4H13A1 1 0 0 1 14 5V5A1 1 0 0 1 13 6H10A1 1 0 0 1 9 5V5A1 1 0 0 1 10 4Z" fill="#7f89e0" />
      <path d="M10 7H13A1 1 0 0 1 14 8V8A1 1 0 0 1 13 9H10A1 1 0 0 1 9 8V8A1 1 0 0 1 10 7Z" fill="#7f89e0" />
      <path d="M10 10H13A1 1 0 0 1 14 11V11A1 1 0 0 1 13 12H10A1 1 0 0 1 9 11V11A1 1 0 0 1 10 10Z" fill="#7f89e0" />
    </svg>
  );
}
