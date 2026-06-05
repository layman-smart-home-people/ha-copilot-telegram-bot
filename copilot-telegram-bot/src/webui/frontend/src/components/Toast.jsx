export default function Toast({ message, type }) {
  const icon = type === "error" ? "❌" : "✅";
  return (
    <div className={`toast ${type}`}>
      {icon} {message}
    </div>
  );
}
