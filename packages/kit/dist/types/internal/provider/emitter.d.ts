type Listener = (...args: readonly unknown[]) => void;
export declare class TbcEventEmitter {
    #private;
    on(event: string, listener: Listener): void;
    removeListener(event: string, listener: Listener): void;
    emit(event: string, payload: unknown): void;
    clear(): void;
}
export {};
