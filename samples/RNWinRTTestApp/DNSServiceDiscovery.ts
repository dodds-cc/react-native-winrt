// const Dnssd = Windows.Networking.ServiceDiscovery.Dnssd;
// const DnssdServiceWatcher = Dnssd.DnssdServiceWatcher;

export interface DnssdServiceInfo {
    hostName: string;
    port: number;
}

// interface IDnssdServiceInstance {
//     hostName: string;
//     port: number;
//     // ... any other properties that the DnssdServiceInstance might have
// }

// export const discoverServicesByServiceName = async (serviceName: string): Promise<DnssdServiceInfo[]> => {
//     const services: DnssdServiceInfo[] = [];

//     const serviceWatcher = new DnssdServiceWatcher(serviceName);

//     serviceWatcher.onServiceFound = (foundService: IDnssdServiceInstance) => {
//         services.push({
//             hostName: foundService.hostName,
//             port: foundService.port
//         });
//     };

//     await serviceWatcher.start();
//     setTimeout(() => serviceWatcher.stop(), 10000); 

//     return services;
// }

export const discoverServicesByServiceName = async (serviceName: string): Promise<DnssdServiceInfo[]> => {
    // Dummy data
    return [
        { hostName: 'device1.local', port: 8080 },
        { hostName: 'device2.local', port: 8000 },
        { hostName: 'device3.local', port: 9000 }
    ];
}
