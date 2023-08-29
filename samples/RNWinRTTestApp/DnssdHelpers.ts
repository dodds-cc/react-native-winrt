const Dnssd = Windows.Networking.ServiceDiscovery.Dnssd;
const DnssdServiceWatcher = Dnssd.DnssdServiceWatcher;

/**
 * Encapsulates an instance of a service that uses DNS Service Discovery (DNS-SD).
 * This interface is based on Windows.Networking.ServiceDiscovery.Dnssd.DnssdServiceInstance.
 * 
 * https://learn.microsoft.com/en-us/uwp/api/windows.networking.servicediscovery.dnssd.dnssdserviceinstance?view=winrt-22621
 */
export interface IDnssdServiceInstance {
    /** Host name of discovered service. */
    hostName: string;

    /** Service type portion of DNS-SD service instance name. (e.g. "_ipp._tcp" in "myservice._ipp._tcp.local") */
    serviceName: string;

    /** Instance portion of DNS-SD service instance name.(e.g. "myservice" in "myservice._ipp._tcp.local") */
    instanceName: string;

    /**
     * An array of IP addresses associated with discovered service.
     * Note: 
     * - 0th item is IPv4 address.
     * - 1st item is IPv6 address.
     */
    ipAddresses: string[];

    /** IPv4 address of discovered service. Corresponds to 0th item of `ipAddresses` array. */
    ipv4Address: string;

    /** IPv6 address of discovered service. Corresponds to 1st item of `ipAddresses` array. */
    ipv6Address: string;

    /** Port number on which service is listening. */
    portNumber: number;

    /** Text data associated with the service instance. Each string is typically a key-value pair, separated by "=". */
    textAttributes: string;
}

function delay(ms: number): Promise<void> {
    return new Promise<void>(resolve => setTimeout(() => resolve(), ms));
}

/**
 * Helper class for looking up devices using the DNS-SD protocol.
 * The class is implemented as a singleton, ensuring only one instance is created.
 * 
 * @remarks
 * This helper focuses on devices that adhere to specific query parameters defined internally. If needed, this can easily be made more generic.
 */
export class DnssdLookupHelper {
    private static instance: DnssdLookupHelper;

    private constructor() { } // Private constructor ensures no external instantiation

    // Parameters to construct AQS query.
    // For specifics, refer https://learn.microsoft.com/en-us/windows/uwp/devices-sensors/enumerate-devices-over-a-network.
    private static readonly PROTOCOL_GUID = "{4526e8c1-8aac-4153-9b16-55e86ada0e54}"; // Protocol type for DNS-SD.
    private static readonly DOMAIN = "local"; // Example: "local" in "fooDevice._ssh._tcp.local".
    private static readonly SERVICE_NAME = "_ipp._tcp"; // Change as needed. Example: "_ipp._tcp" in "fooDevice._ssh._tcp.local".

    private static readonly aqsQuery = `System.Devices.AepService.ProtocolId:=${DnssdLookupHelper.PROTOCOL_GUID} 
                                        AND System.Devices.Dnssd.Domain:=${DnssdLookupHelper.DOMAIN} 
                                        AND System.Devices.Dnssd.ServiceName:=${DnssdLookupHelper.SERVICE_NAME}`;

    // Used to construct an iterable list of properties to look for in the devices that are discovered.
    private static readonly HOSTNAME_PROPERTY = "System.Devices.Dnssd.HostName";
    private static readonly SERVICENAME_PROPERTY = "System.Devices.Dnssd.ServiceName";
    private static readonly INSTANCENAME_PROPERTY = "System.Devices.Dnssd.InstanceName";
    private static readonly IPADDRESS_PROPERTY = "System.Devices.IpAddress";
    private static readonly PORTNUMBER_PROPERTY = "System.Devices.Dnssd.PortNumber";
    private static readonly TEXTATTRIBUTES_PROPERTY = "System.Devices.Dnssd.TextAttributes";

    // TO DO: Support changing propertyKeys from consumer-side if needed.
    private static readonly propertyKeys = [
        DnssdLookupHelper.HOSTNAME_PROPERTY,
        DnssdLookupHelper.SERVICENAME_PROPERTY,
        DnssdLookupHelper.INSTANCENAME_PROPERTY,
        DnssdLookupHelper.IPADDRESS_PROPERTY,
        DnssdLookupHelper.PORTNUMBER_PROPERTY,
        DnssdLookupHelper.TEXTATTRIBUTES_PROPERTY
    ];

    // NOTE: Casting `propertyKeys` to `unknown` first, and then to `Windows.Foundation.Collections.IIterable<string>`
    // is a workaround to bypass type-related errors thrown by VS Code and in the runtime.
    private static propertyKeysEnumerable = DnssdLookupHelper.propertyKeys as unknown as Windows.Foundation.Collections.IIterable<string>;

    private DeviceWatcher : Windows.Devices.Enumeration.DeviceWatcher = null!;

    /**
     * Gets the singleton instance of `DnssdLookupHelper`.
     * If no instance exists, it initializes a new one.
     * @example
     * const finder = DnssdLookupHelper.getInstance();
     * @returns The singleton instance of the `DnssdLookupHelper` class.
     */
    public static getInstance(): DnssdLookupHelper {
        if (!DnssdLookupHelper.instance) {
            DnssdLookupHelper.instance = new DnssdLookupHelper();
        }
        return DnssdLookupHelper.instance;
    }

    /**
     * Enumerates IDnssdServiceInstance implementing objects matching the query parameters.
     * @example
     * const finder = DnssdLookupHelper.getInstance();
     * let devices = await finder.findAllDevicesAsync();
     * @returns A Promise that resolves to an array of objects implementing IDnssdServiceInstance.
     */
    public async findAllDevicesAsync(): Promise<IDnssdServiceInstance[]> {
        let services: IDnssdServiceInstance[] = [];
    
        try {
            let comDevices = await Windows.Devices.Enumeration.DeviceInformation.findAllAsync(
                DnssdLookupHelper.aqsQuery,
                DnssdLookupHelper.propertyKeysEnumerable,
                Windows.Devices.Enumeration.DeviceInformationKind.associationEndpointService
            );
    
            for (let i = 0; i < comDevices.size; i++) {
                let comDevice = comDevices.getAt(i);
                let device = this.getDeviceFromProperties(comDevice.properties);
                services.push(device as IDnssdServiceInstance);
            }
            console.log(`Found ${services.length} service(s)`);
        } catch (error) {
            console.error("Error discovering devices:", error);
        }
    
        return services;
    }

    /**
     * A map that holds unique devices discovered by the device watcher during its listening sessions.
     * The contents of this map are cleared when the watcher is stopped, ensuring it remains fresh for each listening session.
     */
    private discoveredDevicesMap: { [id: string]: IDnssdServiceInstance } = {};

    private currentSessionCallback: (discoveredServices: IDnssdServiceInstance[]) => void = () => {};

    private DEVICE_INFORMATION_PARSING_DELAY : number = 500;
    
    /**
     * Starts listening for devices and subscribes to the `added` and `updated` events.
     * 
     * This function creates a watcher to look for devices on the network. 
     * The lookup happens in two parts, roughly:
     * 1. An initial scan to discover all currently available devices. Here, all available devices are enumerated.
     * 2. Once enumeration is completed, continuous monitoring for updates, such as when a new device is added to the network.
     * 
     * It's worth noting that devices already discovered during the initial scan may, under some conditions, trigger the "updated" event. 
     * To work around this, we maintain a hash map and only add a new device when its ID is unique.
     *
     * @param callback A function that's invoked whenever a new device is detected or an existing one is updated. This function must accept an array of all devices discovered so far.
     * @example
     * const finder = DnssdLookupHelper.getInstance();
     * finder.startListeningForDevicesAsync((services) => {
     *     console.log(`Total services discovered: ${services.length}`);
     * });
     * 
     * @returns A Promise that resolves to a boolean. The promise will return `true` if the watcher was successfully started, and `false` otherwise.
     */
    public startListeningForDevicesAsync(callback: (discoveredServices: IDnssdServiceInstance[]) => void,
                                                    shouldListenForUpdates: boolean = false): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            let status = false;
            
            this.DeviceWatcher = null!;
            if (!this.DeviceWatcher) {
                this.DeviceWatcher = Windows.Devices.Enumeration.DeviceInformation.createWatcher(
                    DnssdLookupHelper.aqsQuery,
                    DnssdLookupHelper.propertyKeysEnumerable,
                    Windows.Devices.Enumeration.DeviceInformationKind.associationEndpointService
                );

                this.currentSessionCallback = callback;
    
                this.DeviceWatcher.addEventListener("enumerationcompleted", (_watcher, _comDevice) => {
                    console.log(`device enumeration completed. watcher status: ${_watcher.status}`);
                    if (!shouldListenForUpdates)
                    {
                        this.stopListeningForDevices();
                    }
                });

                // After starting the watcher, a complete network scan is done until all the available devices are enumerated.
                // For each discovered device, the added event is raised. However, once the initial enumeration is completed,
                // the added event will not be fired when new devices are added to the network.
                // this.DeviceWatcher.addEventListener("added", async (_watcher, _comDevice) => {
                //     await this.handleDeviceAdded(_comDevice, callback);
                // });
                this.DeviceWatcher.addEventListener("added", this.onDeviceAdded.bind(this));

                // When a device is added to the network after initial enumeration is completed, the updated event is fired.
                // However, this event false fires as well, saying devices discovered in intitial scan were updated while they
                // were not. To work around this, we first check if this device was already discovered.
                if (shouldListenForUpdates)
                {
                    this.DeviceWatcher.addEventListener("updated", this.onDeviceUpdated.bind(this));
                }

                this.DeviceWatcher.start();
                status = true;
            }

            resolve(status);
        });
    }

    private async onDeviceAdded(_watcher: any, _comDevice: any): Promise<void> {
        await this.handleDeviceAdded(_comDevice, this.currentSessionCallback);
    }
    
    private async handleDeviceAdded(_comDevice: any, callback: (discoveredServices: IDnssdServiceInstance[]) => void): Promise<void> {
        await delay(this.DEVICE_INFORMATION_PARSING_DELAY);
        var id = _comDevice.id;
        if (!this.discoveredDevicesMap[id])
        {
            var device = this.getDeviceFromProperties(_comDevice.properties);
            this.discoveredDevicesMap[id] = device as IDnssdServiceInstance;
            console.log(`device with id ${id} added..`);          
            callback(Object.values(this.discoveredDevicesMap));
        }
    }

    private async onDeviceUpdated(_watcher: any, _comDevice: any): Promise<void> {
        await this.handleDeviceUpdated(_comDevice, this.currentSessionCallback);
    }

    private async handleDeviceUpdated(_comDevice: any, callback: (discoveredServices: IDnssdServiceInstance[]) => void): Promise<void> {
        await delay(this.DEVICE_INFORMATION_PARSING_DELAY);
        var id = _comDevice.id;
        if (!this.discoveredDevicesMap[id])
        {
            var device = this.getDeviceFromProperties(_comDevice.properties);
            this.discoveredDevicesMap[id] = device as IDnssdServiceInstance;
            console.log(`device with id ${id} updated..`);
            callback(Object.values(this.discoveredDevicesMap));
        }
    }

    /**
     * Stops the device watcher from listening for new devices.
     * @remarks
     * If the watcher was not previously started, or is already stopped, this method will return `false`. On successful stopping, the method returns `true`.
     * @example
     * // Stopping the device watcher:
     * const wasStopped = finder.stopListeningForDevices();
     * @returns A boolean indicating whether the watcher was successfully stopped (`true`) or not (`false`).
     */
    public stopListeningForDevices(): boolean {
        if (this.DeviceWatcher)
        {
            console.log("stopping device watcher");
            this.DeviceWatcher.stop();
            // this.DeviceWatcher.removeEventListener("added", this.onDeviceAdded.bind(this));
            // this.DeviceWatcher.removeEventListener("updated", this.onDeviceUpdated.bind(this));
            this.DeviceWatcher = null!;
            this.discoveredDevicesMap = {};
            return true;
        }
        return false;
    }

    /**
     * Extracts device properties from the given IMapView object and constructs an IDnssdServiceInstance object.
     *
     * @param properties - An IMapView containing device properties.
     * @returns A Partial<IDnssdServiceInstance> containing extracted device properties.
     */
    private getDeviceFromProperties(properties: Windows.Foundation.Collections.IMapView<string, any>): Partial<IDnssdServiceInstance> {   
        let serviceInfo: Partial<IDnssdServiceInstance> = {};
    
        DnssdLookupHelper.propertyKeys.forEach((key: string) => {
            if (properties.hasKey(key)) {
                const value = properties.lookup(key);
                switch (key) {
                    case DnssdLookupHelper.HOSTNAME_PROPERTY:
                        serviceInfo.hostName = value;
                        break;
                    case DnssdLookupHelper.SERVICENAME_PROPERTY:
                        serviceInfo.serviceName = value;
                        break;
                    case DnssdLookupHelper.INSTANCENAME_PROPERTY:
                        serviceInfo.instanceName = value;
                        break;
                    case DnssdLookupHelper.IPADDRESS_PROPERTY:
                        let ipAddressesArray = value as string[];
                        serviceInfo.ipAddresses = ipAddressesArray;

                        // Handles cases where:
                        // 1. Both ipv4 and ipv6 addresses are present
                        // 2. Only an ipv6 address is present
                        if (ipAddressesArray.length > 0) {
                            // Regex to check if an IP address is IPv4
                            const ipv4Pattern = /^((25[0-5]|(2[0-4]|1\d|[1-9]|)\d)\.?\b){4}$/;
    
                            if (ipv4Pattern.test(ipAddressesArray[0])) {
                                serviceInfo.ipv4Address = ipAddressesArray[0];
                            } else {
                                serviceInfo.ipv6Address = ipAddressesArray[0];
                            }
                        }
    
                        // Handles cases where both ipv4 and ipv6 addresses are present
                        if (ipAddressesArray.length > 1) {
                            // If two addresses are present, assume the second is always IPv6
                            serviceInfo.ipv6Address = ipAddressesArray[1];
                        }
                        break;
                    case DnssdLookupHelper.PORTNUMBER_PROPERTY:
                        serviceInfo.portNumber = value;
                        break;
                    case DnssdLookupHelper.TEXTATTRIBUTES_PROPERTY:
                        serviceInfo.textAttributes = value;
                        break;
                }
            }
        });
    
        return serviceInfo;
    }
}