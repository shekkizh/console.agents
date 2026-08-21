import { defineAgent, defineDynamic } from "eve";
import { config } from "@/lib/server/config";

export default defineAgent({
  model: defineDynamic({
    events: {
      "session.started": () => config.eveModelId,
    },
  }),
});
