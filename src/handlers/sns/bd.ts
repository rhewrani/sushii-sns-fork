import z from "zod";

export const BdTriggerResponseSchema = z.object({
  snapshot_id: z.string().optional(),
});

export type BdTriggerResponse = z.infer<typeof BdTriggerResponseSchema>;

export const BdMonitorStatus = z.enum(["starting", "running", "ready", "failed"]);

export const BdMonitorResponseSchema = z.object({
  status: BdMonitorStatus,
  snapshot_id: z.string().optional(),
  // dataset_id: z.string().optional(),
  // records: z.number().optional(),
  errors: z.any().optional(),
  // collection_duration: z.number().optional(),
});
export type BdMonitorResponse = z.infer<typeof BdMonitorResponseSchema>;
