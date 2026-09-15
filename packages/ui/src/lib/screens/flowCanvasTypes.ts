import type { Edge, Node } from '@xyflow/svelte';
import type { AutomationKindDto } from '$lib/bindings';

// The svelte-flow canvas's node/edge shapes for the Flow graph editor — denormalized
// from FlowNodeDto/FlowEdgeDto (see FlowEditor.svelte) so the canvas never has to look
// an automation up mid-render: `automationName`/`automationKind` are snapshotted onto
// the node's data when it's added or the editor opens, the same way the old
// checkbox-list editor read them once per render from `$automations`.
export interface FlowCanvasNodeData extends Record<string, unknown> {
  automationId: string;
  label: string;
  continueOnError: boolean;
  automationName: string;
  automationKind: AutomationKindDto;
}

export type AutomationFlowNode = Node<FlowCanvasNodeData, 'automation'>;
export type AutomationFlowEdge = Edge;
