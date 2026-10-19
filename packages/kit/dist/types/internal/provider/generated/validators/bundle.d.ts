export declare const validate: typeof validate1122;
export default validate1122;
declare function validate1122(data: any, { instancePath, parentData, parentDataProperty, rootData, dynamicAnchors }?: {
    instancePath?: string | undefined;
    rootData?: any;
    dynamicAnchors?: {} | undefined;
}): boolean;
declare namespace validate1122 {
    var evaluated: {
        props: boolean;
        dynamicProps: boolean;
        dynamicItems: boolean;
    };
}
