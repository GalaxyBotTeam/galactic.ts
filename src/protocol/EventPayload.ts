export type EventPayload = {
    id: string,
    type: 'message' | 'response' | 'response_error',
    data: unknown,
} | {
    id: string,
    type: 'request',
    data: unknown,
    timeout: number
}