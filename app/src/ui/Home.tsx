export function Home({ loading, taskCount, blockCount }: {
  loading: boolean;
  taskCount: number;
  blockCount: number;
}) {
  return (
    <section aria-labelledby="home-heading">
      <h2 id="home-heading">Home</h2>
      {loading ? (
        <p role="status">Loading your planner…</p>
      ) : taskCount === 0 && blockCount === 0 ? (
        <p role="status">No tasks and no work blocks yet. Your planner is empty.</p>
      ) : (
        <ul className="counts">
          <li>Tasks: {taskCount}</li>
          <li>Work blocks: {blockCount}</li>
        </ul>
      )}
    </section>
  );
}
