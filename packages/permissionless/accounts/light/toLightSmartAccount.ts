import {
    type Address,
    type Assign,
    type Client,
    type Hex,
    type LocalAccount,
    concat,
    encodeFunctionData,
    hashMessage,
    hashTypedData
} from "viem"
import {
    type SmartAccount,
    type SmartAccountImplementation,
    type UserOperation,
    entryPoint06Abi,
    type entryPoint06Address,
    entryPoint07Abi,
    entryPoint07Address,
    getUserOperationHash,
    toSmartAccount
} from "viem/account-abstraction"
import { getChainId, signMessage } from "viem/actions"
import { getAction } from "viem/utils"
import { getAccountNonce } from "../../actions/public/getAccountNonce"
import { getSenderAddress } from "../../actions/public/getSenderAddress"

const getAccountInitCode = async (
    owner: Address,
    index = BigInt(0)
): Promise<Hex> => {
    if (!owner) throw new Error("Owner account not found")

    return encodeFunctionData({
        abi: [
            {
                inputs: [
                    {
                        internalType: "address",
                        name: "owner",
                        type: "address"
                    },
                    {
                        internalType: "uint256",
                        name: "salt",
                        type: "uint256"
                    }
                ],
                name: "createAccount",
                outputs: [
                    {
                        internalType: "contract LightAccount",
                        name: "ret",
                        type: "address"
                    }
                ],
                stateMutability: "nonpayable",
                type: "function"
            }
        ],
        functionName: "createAccount",
        args: [owner, index]
    })
}

export type LightAccountVersion<entryPointVersion extends "0.6" | "0.7"> =
    entryPointVersion extends "0.6" ? "1.1.0" : "2.0.0"

export type ToLightSmartAccountParameters<
    entryPointVersion extends "0.6" | "0.7" = "0.7",
    entryPointAbi extends
        | typeof entryPoint06Abi
        | typeof entryPoint07Abi = typeof entryPoint07Abi
> = {
    client: Client
    entryPoint?: {
        address: typeof entryPoint06Address | typeof entryPoint07Address
        abi: entryPointAbi
        version: entryPointVersion
    }
    owner: LocalAccount
    version: LightAccountVersion<entryPointVersion>
    factoryAddress?: Address
    index?: bigint
    address?: Address
    nonceKey?: bigint
}

async function signWith1271WrapperV1(
    signer: LocalAccount,
    chainId: number,
    accountAddress: Address,
    hashedMessage: Hex
): Promise<Hex> {
    return signer.signTypedData({
        domain: {
            chainId: Number(chainId),
            name: "LightAccount",
            verifyingContract: accountAddress,
            version: "1"
        },
        types: {
            LightAccountMessage: [{ name: "message", type: "bytes" }]
        },
        message: {
            message: hashedMessage
        },
        primaryType: "LightAccountMessage"
    })
}

const LIGHT_VERSION_TO_ADDRESSES_MAP: {
    [key in LightAccountVersion<"0.6" | "0.7">]: {
        factoryAddress: Address
    }
} = {
    "1.1.0": {
        factoryAddress: "0x00004EC70002a32400f8ae005A26081065620D20"
    },
    "2.0.0": {
        factoryAddress: "0x0000000000400CdFef5E2714E63d8040b700BC24"
    }
}

const getDefaultAddresses = (
    lightAccountVersion: LightAccountVersion<"0.6" | "0.7">,
    {
        factoryAddress: _factoryAddress
    }: {
        factoryAddress?: Address
    }
) => {
    const factoryAddress =
        _factoryAddress ??
        LIGHT_VERSION_TO_ADDRESSES_MAP[lightAccountVersion].factoryAddress

    return {
        factoryAddress
    }
}

export type LightSmartAccountImplementation<
    entryPointVersion extends "0.6" | "0.7",
    entryPointAbi extends
        | typeof entryPoint06Abi
        | typeof entryPoint07Abi = entryPointVersion extends "0.6"
        ? typeof entryPoint06Abi
        : typeof entryPoint07Abi
> = Assign<
    SmartAccountImplementation<entryPointAbi, entryPointVersion>,
    { sign: NonNullable<SmartAccountImplementation["sign"]> }
>

export type ToLightSmartAccountReturnType<
    entryPointVersion extends "0.6" | "0.7" = "0.7",
    entryPointAbi extends
        | typeof entryPoint06Abi
        | typeof entryPoint07Abi = typeof entryPoint07Abi
> = SmartAccount<
    LightSmartAccountImplementation<entryPointVersion, entryPointAbi>
>

enum SignatureType {
    EOA = "0x00"
    // CONTRACT = "0x01",
    // CONTRACT_WITH_ADDR = "0x02"
}

/**
 * @description Creates an Light Account from a private key.
 *
 * @returns A Private Key Light Account.
 */
export async function toLightSmartAccount<
    entryPointVersion extends "0.6" | "0.7" = "0.7",
    entryPointAbi extends
        | typeof entryPoint06Abi
        | typeof entryPoint07Abi = typeof entryPoint07Abi
>(
    parameters: ToLightSmartAccountParameters<entryPointVersion, entryPointAbi>
): Promise<ToLightSmartAccountReturnType<entryPointVersion, entryPointAbi>> {
    const {
        version,
        factoryAddress: _factoryAddress,
        address,
        owner,
        client,
        index = BigInt(0),
        nonceKey
    } = parameters

    const entryPoint = {
        address: parameters.entryPoint?.address ?? entryPoint07Address,
        abi:
            parameters.entryPoint?.abi ??
            (parameters.entryPoint?.version ?? "0.7") === "0.6"
                ? entryPoint06Abi
                : entryPoint07Abi,
        version: parameters.entryPoint?.version ?? "0.7"
    } as const

    const { factoryAddress } = getDefaultAddresses(version, {
        factoryAddress: _factoryAddress
    })

    let accountAddress: Address | undefined = address

    let chainId: number

    const getMemoizedChainId = async () => {
        if (chainId) return chainId
        chainId = client.chain
            ? client.chain.id
            : await getAction(client, getChainId, "getChainId")({})
        return chainId
    }

    const getFactoryArgs = async () => {
        return {
            factory: factoryAddress,
            factoryData: await getAccountInitCode(owner.address, index)
        }
    }

    return toSmartAccount({
        client,
        entryPoint,
        getFactoryArgs,
        async getAddress() {
            if (accountAddress) return accountAddress

            const { factory, factoryData } = await getFactoryArgs()

            accountAddress = await getSenderAddress(client, {
                factory,
                factoryData,
                entryPointAddress: entryPoint.address
            })

            return accountAddress
        },
        async encodeCalls(calls) {
            if (calls.length > 1) {
                return encodeFunctionData({
                    abi: [
                        {
                            inputs: [
                                {
                                    internalType: "address[]",
                                    name: "dest",
                                    type: "address[]"
                                },
                                {
                                    internalType: "uint256[]",
                                    name: "value",
                                    type: "uint256[]"
                                },
                                {
                                    internalType: "bytes[]",
                                    name: "func",
                                    type: "bytes[]"
                                }
                            ],
                            name: "executeBatch",
                            outputs: [],
                            stateMutability: "nonpayable",
                            type: "function"
                        }
                    ],
                    functionName: "executeBatch",
                    args: [
                        calls.map((a) => a.to),
                        calls.map((a) => a.value ?? 0n),
                        calls.map((a) => a.data ?? "0x")
                    ]
                })
            }

            return encodeFunctionData({
                abi: [
                    {
                        inputs: [
                            {
                                internalType: "address",
                                name: "dest",
                                type: "address"
                            },
                            {
                                internalType: "uint256",
                                name: "value",
                                type: "uint256"
                            },
                            {
                                internalType: "bytes",
                                name: "func",
                                type: "bytes"
                            }
                        ],
                        name: "execute",
                        outputs: [],
                        stateMutability: "nonpayable",
                        type: "function"
                    }
                ],
                functionName: "execute",
                args: [calls[0].to, calls[0].value ?? 0n, calls[0].data ?? "0x"]
            })
        },
        async getNonce(args) {
            return getAccountNonce(client, {
                address: await this.getAddress(),
                entryPointAddress: entryPoint.address,
                key: args?.key ?? nonceKey
            })
        },
        async getStubSignature() {
            const signature =
                "0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c"

            switch (version) {
                case "1.1.0":
                    return signature
                case "2.0.0":
                    return concat([SignatureType.EOA, signature])
                default:
                    throw new Error("Unknown Light Account version")
            }
        },
        async sign({ hash }) {
            return this.signMessage({ message: hash })
        },
        async signMessage({ message }) {
            const signature = await signWith1271WrapperV1(
                owner,
                await getMemoizedChainId(),
                await this.getAddress(),
                hashMessage(message)
            )

            switch (version) {
                case "1.1.0":
                    return signature
                case "2.0.0":
                    return concat([SignatureType.EOA, signature])
                default:
                    throw new Error("Unknown Light Account version")
            }
        },
        async signTypedData(typedData) {
            const signature = await signWith1271WrapperV1(
                owner,
                await getMemoizedChainId(),
                await this.getAddress(),
                hashTypedData(typedData)
            )

            switch (version) {
                case "1.1.0":
                    return signature
                case "2.0.0":
                    return concat([SignatureType.EOA, signature])
                default:
                    throw new Error("Unknown Light Account version")
            }
        },
        async signUserOperation(parameters) {
            const { chainId = await getMemoizedChainId(), ...userOperation } =
                parameters

            const hash = getUserOperationHash({
                userOperation: {
                    ...userOperation,
                    signature: "0x"
                } as UserOperation<entryPointVersion>,
                entryPointAddress: entryPoint.address,
                entryPointVersion: entryPoint.version,
                chainId: chainId
            })

            const signature = await signMessage(client, {
                account: owner,
                message: {
                    raw: hash
                }
            })

            switch (version) {
                case "1.1.0":
                    return signature
                case "2.0.0":
                    return concat([SignatureType.EOA, signature])
                default:
                    throw new Error("Unknown Light Account version")
            }
        }
    }) as Promise<
        ToLightSmartAccountReturnType<entryPointVersion, entryPointAbi>
    >
}
