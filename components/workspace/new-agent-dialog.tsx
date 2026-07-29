import { ArrowRight, Bot, X } from "lucide-react";
import { useState } from "react";

type NewAgentInput = { name: string; specialty: string; instructions: string };

export function NewAgentDialog({ onClose, onCreate }: {
  onClose: () => void;
  onCreate: (input: NewAgentInput) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !specialty.trim() || instructions.trim().length < 8) return;
    setSaving(true);
    try {
      await onCreate({ name, specialty, instructions });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="new-task-dialog new-agent-dialog" onSubmit={submit}>
        <header>
          <div className="dialog-title">
            <span className="dialog-icon"><Bot size={16} /></span>
            <div><span>Your workspace</span><h2>Create an agent</h2></div>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <p className="dialog-intro">Give this agent a clear role and standing instructions. You can assign work after it joins your workspace.</p>
        <label><span>Name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Research lead" maxLength={60} /></label>
        <label><span>Specialty</span><input value={specialty} onChange={(event) => setSpecialty(event.target.value)} placeholder="Market research and synthesis" maxLength={100} /></label>
        <label><span>Standing instructions</span><textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="How should this agent work, decide, and report back?" rows={7} maxLength={12_000} /></label>
        <footer><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={!name.trim() || !specialty.trim() || instructions.trim().length < 8 || saving}>{saving ? "Creating…" : "Create agent"}<ArrowRight size={16} /></button></footer>
      </form>
    </div>
  );
}
