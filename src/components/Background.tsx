export function Background() {
  return (
    <>
      <div className="bg-grid" />
      <div className="bg-noise" />
      <div className="bg-aurora" aria-hidden>
        <span className="aurora a1" />
        <span className="aurora a2" />
        <span className="aurora a3" />
      </div>
    </>
  );
}
