import { VPC } from "../vpc/vpc";
import { RouteResource } from "../vpc/routeResource";
import { Security } from "../security/security-groups";
import { Roles } from "../security/roles";
import { LaunchTemplate } from "../servers/launch-template";
import { ALB } from "../servers/alb";
import { Tasks } from "../ecs/tasks";
import { Services } from "../ecs/services";
import { Scaling } from "../servers/scaling";
import { CodePipeline } from "../codepipeline/pipelines";
import { NotifyFunction } from "../lambda/notifications";
import { Events } from "../cloudwatch/events";
import { RDS } from "../database/aurora";
import { CDN } from "../cdn/cdn";

import { Construct, Stack, StackProps } from "@aws-cdk/core";
import {
  CfnVPC,
  CfnSubnet,
  CfnInternetGateway,
  CfnVPCGatewayAttachment,
  CfnLaunchTemplate
} from "@aws-cdk/aws-ec2";
import {
  CustomResource,
  CustomResourceProvider
} from "@aws-cdk/aws-cloudformation";

import {
  CfnLoadBalancer,
  CfnListener,
  CfnTargetGroup,
  CfnListenerRule
} from "@aws-cdk/aws-elasticloadbalancingv2";
import { Function, Code, Runtime, CfnPermission } from "@aws-cdk/aws-lambda";
import { CfnLogGroup } from "@aws-cdk/aws-logs";
import {
  CfnCluster,
  CfnTaskDefinition,
  CfnService,
} from "@aws-cdk/aws-ecs";

import { Target } from "../ecs/targets";
import { CfnAutoScalingGroup } from "@aws-cdk/aws-autoscaling";
import { CfnRepository } from "@aws-cdk/aws-codecommit";
import {
  CfnRepository as CfnEcrRepository,
  Repository
} from "@aws-cdk/aws-ecr";
import { CfnPipeline } from "@aws-cdk/aws-codepipeline";
import { CfnRole, CfnInstanceProfile } from "@aws-cdk/aws-iam";
import { CfnBucket } from "@aws-cdk/aws-s3";
import { CfnProject } from "@aws-cdk/aws-codebuild";
import { CfnRule } from "@aws-cdk/aws-events";
import {
  CfnDBCluster,
  CfnDBSubnetGroup,
  CfnDBInstance,
  CfnDBClusterParameterGroup
} from "@aws-cdk/aws-rds";
import { StringParameter } from "@aws-cdk/aws-ssm";
import { CfnSecurityGroup } from "@aws-cdk/aws-ec2";
import { CfnFileSystem, CfnMountTarget } from "@aws-cdk/aws-efs";
import {
  CfnCacheCluster,
  CfnSubnetGroup as CacheSubnetGroup
} from "@aws-cdk/aws-elasticache";
import {
  CfnDistribution,
  CfnCloudFrontOriginAccessIdentity
} from "@aws-cdk/aws-cloudfront";
import {
  CfnService as ServiceDiscovery,
  CfnPrivateDnsNamespace
} from "@aws-cdk/aws-servicediscovery";

import { YamlConfig } from "./yaml-dir";
import * as path from "path";

export class BawsStack extends Stack {
  id: string;
  props: BawsProps;

  constructor(scope: Construct, id: string, props: BawsProps) {
    super(scope, id, props);

    this.id = id;
    this.props = props;
    const config = YamlConfig.getConfigFile("config.yml");

    this.createStack(config);
  }

  public createStack = (config: any) => {
    const keyName = this.node.tryGetContext("ec2Key");
    const bastionIps = this.node.tryGetContext("bastionIps");
    const sslArn = this.node.tryGetContext("SSLCertArn");

    let sslArns: string[] = [sslArn];
    if (typeof config.alb.certificates !== "undefined") {
      sslArns = [sslArn, ...config.alb.certificates];
    }

    let listenerPortsMap: Map<number, CfnListener> = new Map();

    let ecrMap: Map<string, string> = new Map();
    let targets: CfnTargetGroup[] = [];
    let targetMap: Map<string, string> = new Map();
    let targetRefs: string[] = [];

    let efsId: string | boolean = false;

    let publicSubnets: CfnSubnet[] = [];
    let subnetIds: string[] = [];

    let serviceDiscoveryMap: Map<string, string[]> = new Map();

    const bucketMap: Map<string, BucketProps> = new Map();

    //Create VPC
    const vpc = new CfnVPC(
      this,
      `baws-vpc-${this.id}`,
      VPC.getVpcProps(config.vpc)
    );
    const vpcId = vpc.ref;
    const azs = this.availabilityZones;
    const vpcPublicSubnets = VPC.getSubnetProps(vpc, azs, config.vpc);

    vpcPublicSubnets.forEach(item => {
      const subnet = new CfnSubnet(
        this,
        `baws-vpc-subnet-${item.availabilityZone}`,
        item
      );
      subnet.addDependsOn(vpc);
      publicSubnets.push(subnet);
      subnetIds.push(subnet.ref);
    });

    const gateway = new CfnInternetGateway(
      this,
      `baws-vpc-gateway-${this.id}`,
      { tags: [{ key: "Name", value: config.vpc.name }] }
    );
    gateway.addDependsOn(vpc);
    const gatewayAttach = new CfnVPCGatewayAttachment(
      this,
      `baws-vpc-gateway-attach-${this.id}`,
      {
        vpcId,
        internetGatewayId: gateway.ref
      }
    );
    gatewayAttach.addDependsOn(gateway);

    const routeFunction = new Function(this, `baws-route-function-${this.id}`, {
      functionName: `baws-route-resource-${this.id}`,
      description:
        "Created by baws CDK to allow internet traffic into the main route table.",
      runtime: Runtime.NODEJS_10_X,
      handler: "index.handler",
      code: Code.fromAsset(path.join(__dirname, "../vpc/routeTableFunction"))
    });

    routeFunction.addToRolePolicy(RouteResource.getRoutePolicyStatement());

    new CustomResource(this, "baws-route-resource", {
      provider: CustomResourceProvider.lambda(routeFunction),
      properties: {
        vpcid: vpcId
      }
    });

    // Roles.
    const roleName = "baws-ec2-instance";
    const ec2Role = new CfnRole(
      this,
      `baw-ec2-role-${this.id}`,
      Roles.getEc2RoleProps(roleName)
    );
    const ec2InstanceRole = new CfnInstanceProfile(
      this,
      "baws-ec2-instance-profile",
      {
        instanceProfileName: "baws-instance-profile",
        roles: [roleName]
      }
    );
    ec2InstanceRole.addDependsOn(ec2Role);

    const ecsExecutionRole = new CfnRole(
      this,
      `baws-ecs-execution-role-${this.id}`,
      Roles.geteEcsExecutionRoleProps()
    );

    const ecsTaskRole = new CfnRole(
      this,
      `baws-ecs-task-role-${this.id}`,
      Roles.getEcsTaskRoleProps()
    );

    const stackRoles: StackRoles = {
      ec2: ec2Role,
      ec2Instance: ec2InstanceRole,
      ecsExecution: ecsExecutionRole,
      ecsTask: ecsTaskRole
    };

    // Security Groups
    const albSecurity = new CfnSecurityGroup(
      this,
      `baws-alb-security-${this.id}`,
      Security.getAlbGroupProps(vpcId, bastionIps)
    );
    albSecurity.addDependsOn(vpc);

    const ec2Security = new CfnSecurityGroup(
      this,
      `baws-ec2-seucrity-${this.id}`,
      Security.getEc2GroupProps(vpcId, albSecurity, bastionIps)
    );
    ec2Security.addDependsOn(albSecurity);

    const rdsSecurity = new CfnSecurityGroup(
      this,
      `baws-rds-security-${this.id}`,
      Security.getRdsGroupProps(vpcId, ec2Security)
    );
    rdsSecurity.addDependsOn(ec2Security);

    const cacheSecurity = new CfnSecurityGroup(
      this,
      `baws-cache-security-${this.id}`,
      Security.getCacheGroupProps(vpcId, ec2Security)
    );
    cacheSecurity.addDependsOn(ec2Security);

    const efsSecurity = new CfnSecurityGroup(
      this,
      `baws-efs-security-${this.id}`,
      Security.getEfsGroupProps(vpcId, ec2Security)
    );
    efsSecurity.addDependsOn(ec2Security);

    const stackSecurity: StackSecurityGroups = {
      ec2: ec2Security,
      alb: albSecurity,
      efs: efsSecurity,
      cache: cacheSecurity,
      rds: rdsSecurity
    };

    const cluster = new CfnCluster(this, "baws-cluster", {
      clusterName: config.ecs.clusterName
    });

    // Elastic File System
    if (this.props.efs) {
      const efs = new CfnFileSystem(this, "baws-cfnefs", {
        encrypted: false,
        fileSystemTags: [
          {
            key: "Name",
            value: config.efs.name
          }
        ]
      });

      for (let i = 0; i < publicSubnets.length; i++) {
        const cfnfsTarget = new CfnMountTarget(this, `baws-efs-target-${i}`, {
          subnetId: publicSubnets[i].ref,
          fileSystemId: efs.ref,
          securityGroups: [stackSecurity.efs.ref]
        });
        cfnfsTarget.addDependsOn(efs);
        cfnfsTarget.addDependsOn(stackSecurity.efs);
      }

      efsId = efs.ref;
    }

    // Prepare pipeeline variables.
    const s3Dir = YamlConfig.getDirConfigs(config.s3.configDir);
    const s3Config =
      typeof config.s3.buckets !== "undefined" ? config.s3.buckets : [];
    const s3Buckets: any[] = [...s3Dir, ...s3Config];

    s3Buckets.forEach((item: any, index: number) => {
      const bucketName =
        item.addUniqueId === true ? `${item.name}-${this.account}` : item.name;
      s3Buckets[index].bucketName = bucketName;

      const bucket = new CfnBucket(this, `baws-s3-${item.name}`, {
        bucketName
      });
      bucketMap.set(item.type, {
        name: bucketName,
        arn: bucket.attrArn,
        domain: bucket.attrDomainName
      });
    });

    // const launchTemplates
    const launchTemplateProps = new LaunchTemplate();

    const launchTemplate = new CfnLaunchTemplate(
      this,
      `baws-launch-${this.id}`,
      launchTemplateProps.getLaunchTemplateProps(
        config.scaling.launchTemplate,
        {
          keyName,
          efsId,
          securityId: stackSecurity.ec2.ref,
          instanceProfileRole: ec2InstanceRole.attrArn,
          clusterName: config.ecs.clusterName,
          app: this
        }
      )
    );
    launchTemplate.addDependsOn(ec2InstanceRole);

    const alb = new CfnLoadBalancer(this, "baws-alb", {
      subnets: publicSubnets.map(x => x.ref),
      ipAddressType: "ipv4",
      name: config.alb.name,
      scheme: "internet-facing",
      type: "application",
      securityGroups: [stackSecurity.alb.ref]
    });
    alb.addDependsOn(gatewayAttach);

    const targetGroup = new CfnTargetGroup(
      this,
      `baws-default-target-${this.id}`,
      ALB.getAlbTargetProps(vpcId)
    );

    targetGroup.addDependsOn(alb);

    const redirect = new CfnListener(
      this,
      `baws-listener-redirect-${this.id}`,
      ALB.getPortRedirectListenerProps(alb.ref)
    );
    redirect.addDependsOn(alb);
    listenerPortsMap.set(80, redirect);

    const listener = new CfnListener(
      this,
      `baws-listener-default`,
      ALB.getListenerProps({
        albArn: alb.ref,
        sslArn,
        targetRef: targetGroup.ref
      })
    );
    listener.addDependsOn(alb);
    listener.addDependsOn(targetGroup);
    listenerPortsMap.set(443, listener);

    // Begin task creation.
    const taskDir = YamlConfig.getDirConfigs(config.ecs.configDir);
    const taskConfig =
      typeof config.ecs.tasks !== "undefined" ? config.ecs.tasks : [];
    const tasks: string[] = [...taskDir, ...taskConfig];

    let counter = 1;

    // Build our targets, so we can associate the scaling groups.
    tasks.forEach((item: any) => {
      // @todo support IP based targets.
      // There are no associated listeners if network type is awsvpc.
      if (typeof item.listeners !== "undefined") {
        const target = new CfnTargetGroup(
          this,
          `baws-target-${item.name}`,
          Target.getTargetProps(item, { vpcId })
        );
        target.addDependsOn(alb);
        targets.push(target);
        targetMap.set(item.name, target.ref);
        targetRefs.push(target.ref);
        // Just in case network was defined as awsvpc, but the listeners were
        // Add new listener if it's a new port we haven't created yet.
        item.listeners.forEach((listener: any) => {
          if (
            typeof listener.listenerPort !== "undefined" &&
            typeof listenerPortsMap.get(listener.listenerPort) === "undefined"
          ) {
            const listen = new CfnListener(
              this,
              `baws-listener-${listener.listenerPort}`,
              ALB.getListenerProps({
                port: listener.listenerPort,
                albArn: alb.ref,
                sslArn,
                targetRef: targetGroup.ref
              })
            );

            listenerPortsMap.set(listener.listenerPort, listen);
          }
        });

        item.listeners.forEach((listen: any) => {
          // Add listener rules.
          const taskPort =
            typeof listen.listenerPort === "undefined"
              ? 443
              : listen.listenerPort;
          const cfnListen = listenerPortsMap.get(taskPort);
          const listenerProps = new Services();

          if (typeof cfnListen !== "undefined") {
            const listenerName =
              typeof listen.name !== "undefined"
                ? listen.name
                : listen.priority;

            const listenerRule = new CfnListenerRule(
              this,
              `baws-listener-rule-${item.name}-${listenerName}`,
              listenerProps.getListenerRuleProps(listen, {
                listenerRef: cfnListen.ref,
                targetRef: target.ref
              })
            );
            listenerRule.addDependsOn(cfnListen);
            listenerRule.addDependsOn(target);

            counter++;
          }
        });
      }

      // Add the discovery name to the namespace, if it doesn't exist.
      // But first, check to see that we have both namespace and discovery name.
      if (
        typeof item.namespace !== "undefined" &&
        typeof item.discoveryName !== "undefined"
      ) {
        let discoveryNames = serviceDiscoveryMap.get(item.namespace);
        // We've already declared this name space,
        // so check to see that we're not adding a duplicate discoveryName.
        if (typeof discoveryNames !== "undefined") {
          if (discoveryNames.indexOf(item.discoveryName) > -1) {
            this.node.addError(
              `Discovery name ${item.discoveryName} already declared. Discovery names must be unique.`
            );
          } else {
            discoveryNames.push(item.discoveryName);
            serviceDiscoveryMap.set(item.namespace, discoveryNames);
          }
          // We haven't added the namespace yet, so just add the incoming values.
        } else {
          serviceDiscoveryMap.set(item.namespace, [item.discoveryName]);
        }
      }
    });

    const scaling = new CfnAutoScalingGroup(
      this,
      `baws-scaling-${this.id}`,
      Scaling.getScalingProps(config.scaling, {
        subnets: publicSubnets.map(x => x.ref),
        targetArns: targetRefs,
        launchTemplate
      })
    );
    scaling.addDependsOn(vpc);
    targets.forEach(item => {
      scaling.addDependsOn(item);
    });

    if (this.props.cache) {
      const subnetIds = publicSubnets.map(x => x.ref);
      const subnetGroup = new CacheSubnetGroup(this, "baws-cache-subnet", {
        cacheSubnetGroupName: "baws-subnet",
        description: "Subnet group created by Baws CDK.",
        subnetIds
      });

      for (let i = 0; i < config.cache.clusters.length; i++) {
        const cacheConfig = config.cache.clusters[i];
        // const cluster = config[i];
        const cacheCluster = new CfnCacheCluster(
          this,
          `baws-cache-cluster-${cacheConfig.name}`,
          {
            clusterName: cacheConfig.name,
            cacheNodeType: cacheConfig.instanceType,
            numCacheNodes: cacheConfig.clusterSize,
            engine: cacheConfig.engine,
            vpcSecurityGroupIds: [stackSecurity.cache.ref],
            cacheSubnetGroupName: "baws-subnet"
          }
        );
        cacheCluster.addDependsOn(stackSecurity.cache);
        cacheCluster.addDependsOn(subnetGroup);
        const endPoint =
          cacheConfig.engine == "memcached"
            ? cacheCluster.attrConfigurationEndpointAddress
            : cacheCluster.attrRedisEndpointAddress;

        // Create host endpoints in SSM for container reference.
        new StringParameter(this, `baws-cache-host-${cacheConfig.name}`, {
          description: "Created by baws cdk",
          parameterName: cacheConfig.hostParamName,
          stringValue: endPoint
        });
      }
    }

    if (this.props.rds) {
      // Build rds databases

      const dbSubnetGroup = new CfnDBSubnetGroup(this, "baws-db-subnet-group", {
        dbSubnetGroupDescription: "Baws subnet for aurora.",
        subnetIds: publicSubnets.map(x => x.ref)
      });

      const dbClusterPameter = new CfnDBClusterParameterGroup(
        this,
        `baws-rds-cluster-param-${this.id}`,
        RDS.getDBClusterParamProps(config.rds)
      );

      const dbCluster = new CfnDBCluster(
        this,
        `baws-rds-cluster=${this.id}`,
        RDS.getDBClusterProps(this, config.rds, {
          dbSecurityGroupRef: stackSecurity.rds.ref,
          dbSubnetGroupName: dbSubnetGroup.ref,
          dbClusterParamGroupName: dbClusterPameter.ref
        })
      );
      dbCluster.addDependsOn(dbClusterPameter);
      dbCluster.addDependsOn(dbSubnetGroup);

      const dbInstances = RDS.getRdsInstanceProps(
        config.rds,
        dbSubnetGroup.ref,
        dbCluster.ref
      );

      let dbCounter = 0;
      dbInstances.forEach(item => {
        const dbInstance = new CfnDBInstance(
          this,
          `baws-rds-instance-${this.id}-${dbCounter}`,
          item
        );
        dbInstance.addDependsOn(dbCluster);
        dbInstance.addDependsOn(dbSubnetGroup);
        dbCounter++;
      });

      // Create host endpoints in SSM for container reference.
      new StringParameter(this, "baws-db-host", {
        description: "Created by baws cdk",
        parameterName: config.rds.dbHostParamName,
        stringValue: dbCluster.attrEndpointAddress
      });

      new StringParameter(this, "baws-db-host-read", {
        description: "Created by baws cdk",
        parameterName: config.rds.dbROHostParamName,
        stringValue: dbCluster.attrReadEndpointAddress
      });
    }

    // Create service discovery, if we have any definitions
    let cfnServiceDiscoveryRefs:Map<string, string> = new Map();
    serviceDiscoveryMap.forEach((value: string[], key: string) => {
      const nameSpace = new CfnPrivateDnsNamespace(
        this,
        `baws-namespace-${key}`,
        {
          name: key,
          vpc: vpcId
        }
      );
      value.forEach((discoveryName: string) => {
        const discovery = new ServiceDiscovery(
          this,
          `baws-service-${key}-${discoveryName}`,
          {
            name: discoveryName,
            namespaceId: nameSpace.ref,
            description: "Services for baws cdk.",
            dnsConfig: {
              dnsRecords: [
                {
                  ttl: 60,
                  type: "A"
                }
              ]
            }
          }
        );
        discovery.addDependsOn(nameSpace);

        cfnServiceDiscoveryRefs.set(`${discoveryName}.${key}`, discovery.ref);
      });
    });

    // Build out tasks, their log groups, and associated services.
    tasks.forEach((item: any) => {
      const logGroup = new CfnLogGroup(
        this,
        `baws-ecs-log-group-${item.name}`,
        {
          logGroupName: `/ecs/${item.name}`
        }
      );

      if (item.createECR === true) {
        new CfnEcrRepository(this, `baws-ecr-${item.name}`, {
          repositoryName: `${item.name}`
        });
        const uri = Repository.fromRepositoryName(
          this,
          `baws-ecr-lookup-${item.name}`,
          item.name
        );

        ecrMap.set(item.name, uri.repositoryUri);
      }

      if (typeof item) {

      }

      const task = new CfnTaskDefinition(
        this,
        `baws-task-${item.name}`,
        Tasks.getTaskProps(item, {
          region: this.region,
          executionRoleRef: stackRoles.ecsExecution.ref
        })
      );
      task.addDependsOn(logGroup);

      const target = targetMap.get(item.name);

      let serviceProps = {
        targetRef: target,
        taskRef: task.ref,
        clusterName: cluster.clusterName
      };

      // awsvpc requires network security group and subnets.
      if (typeof item.network !== "undefined" && item.network == "awsvpc") {
        const serviceSecurity = new CfnSecurityGroup(
          this,
          `baws-security-service-${item.name}`,
          Security.getGenericPrivateGroupProps(vpcId, item.hostPort)
        );

        const networkConfig = {
          networkConfiguration: {
            subnets: subnetIds,
            securityGroups: [serviceSecurity.ref]
          }
        };

        serviceProps = { ...serviceProps, ...networkConfig };
      }

      // Add network and namespace, which should have been created above,
      // to the service reference.
      if (typeof item.discoveryName !== 'undefined' && typeof item.namespace !== 'undefined') {
        this.node.addInfo(`Found namespace ${item.discoveryName}`);
        const serviceDiscoveryRef = cfnServiceDiscoveryRefs.get(`${item.discoveryName}.${item.namespace}`);
        if (typeof serviceDiscoveryRef !== 'undefined') {
          this.node.addInfo(`Adding discoveryref ${serviceDiscoveryRef}`);
          const registryArn = {
            registryArn: serviceDiscoveryRef
          };
          serviceProps = {
            ...serviceProps, ...registryArn}
        }

      }

      const service = new CfnService(
        this,
        `baws-services-${item.name}`,
        Services.getServiceProps(item, serviceProps)
      );
      service.addDependsOn(alb);
      service.addDependsOn(task);
      service.addDependsOn(cluster);
      service.addDependsOn(scaling);
      targets.forEach(item => {
        scaling.addDependsOn(item);
      });

      // @todo find a sane balance between manual priority handling and simple use.
      counter++;
    });

    const commitReposConfig: string[] = config.commitRepo.repos;
    const commitRepos: CfnRepository[] = [];

    commitReposConfig.forEach((item: any) => {
      const repo = new CfnRepository(this, `baws-commit-repo-${item.name}`, {
        repositoryName: item.name,
        repositoryDescription: item.description
      });
      commitRepos.push(repo);
    });

    // Prepare pipeeline variables.
    const codePipelineDir = YamlConfig.getDirConfigs(
      config.codepipeline.configDir
    );
    const codePipelineConfig =
      typeof config.codepipeline.pipelines !== "undefined"
        ? config.codepipeline.pipelines
        : [];
    const pipelines: string[] = [...codePipelineConfig, ...codePipelineDir];

    const pipelineBucket = bucketMap.get("artifacts");

    // Create all of our pipelines and related components.
    pipelines.forEach((item: any) => {
      const pipelineBuilder = new CodePipeline();

      const logs = new CfnLogGroup(
        this,
        `baws-codepipeline-logs-${item.name}`,
        {
          logGroupName: `/codebuild/${item.name}`
        }
      );

      if (typeof item.bucketNameReference !== "undefined") {
        // If it's an s3 pipeline, we need to lookup the bucket and provide the final name,
        // since it will be different based ont the uniqueid option.
        const bucket: any = s3Buckets.find(
          (bucketConfig: any) => bucketConfig.name == item.bucketNameReference
        );
        if (typeof bucket.bucketName !== "undefined") {
          item.bucketNameReference = bucket.bucketName;
        }
      }

      const pipelineRole = new CfnRole(
        this,
        `baws-pipeline-role-${item.name}`,
        pipelineBuilder.getPipelineRoleProps(item.name)
      );

      const buildName = `${item.name}-build`;
      const buildRole = new CfnRole(
        this,
        `baws-pipeline-build-role-${item.name}`,
        pipelineBuilder.getBuildRoleProps({
          name: buildName,
          region: this.region,
          account: this.account,
          bucketArn:
            typeof pipelineBucket !== "undefined" ? pipelineBucket.arn : ""
        })
      );

      // Build our codebuild
      // Service name and task name are identical, so service name can be used
      // where task name is needed.
      const ecrUri = ecrMap.get(item.taskNameReference);
      if (typeof ecrUri !== "undefined") {
        const build = new CfnProject(
          this,
          `baws-build-${item.name}`,
          pipelineBuilder.getBuildProps({
            name: buildName,
            buildRoleArn: buildRole.attrArn,
            taskName: item.taskNameReference,
            taskURI: ecrUri
          })
        );
        build.addDependsOn(logs);
        build.addDependsOn(buildRole);
      } else {
        const build = new CfnProject(
          this,
          `baws-build-${item.name}`,
          pipelineBuilder.getBuildProps({
            name: buildName,
            buildRoleArn: buildRole.attrArn
          })
        );
        build.addDependsOn(logs);
        build.addDependsOn(buildRole);
      }

      const pipeline = new CfnPipeline(
        this,
        `baws-codepipeline-${item.name}`,
        pipelineBuilder.getCodePipelineProps(item, {
          bucketName:
            typeof pipelineBucket !== "undefined" ? pipelineBucket.name : "",
          taskName: item.taskNameReference,
          pipelineRole
        })
      );
      pipeline.addDependsOn(pipelineRole);

      const pipelineArn = `arn:aws:codepipeline:${this.region}:${this.account}:${item.name}`;
      const repoArn = `arn:aws:codecommit:${this.region}:${this.account}:${item.repoNameReference}`;

      const repoWatchRole = new CfnRole(
        this,
        `baws-repo-role-${item.name}`,
        Roles.getRepoWatchRoleProps(pipelineArn, item.name)
      );

      const watchEvent = new CfnRule(
        this,
        `baws-pipeline-watcher-${item.name}`,
        Events.getPipelineWatcherProps({
          id: item.name,
          pipelineArn: pipelineArn,
          roleArn: repoWatchRole.attrArn,
          repoArn: repoArn,
          branchToWatch: item.branchToWatch
        })
      );
    });

    // Create Pipelines
    // Notify on pipeline changes.
    const notificationConfig = config.notifications;
    if (typeof notificationConfig !== "undefined") {
      const notifyFunction = new Function(
        this,
        `baws-notify-function-${this.id}`,
        NotifyFunction.getFunctionProps(
          config.notifications.codepipeline,
          this.id
        )
      );
      notifyFunction.addToRolePolicy(
        NotifyFunction.getNotificationPolicy(this.region)
      );
      const notifyArn = notifyFunction.functionArn;

      const commitRule = new CfnRule(
        this,
        `baws-commit-rule-${this.id}`,
        Events.getCommitRuleProps(notifyArn, this.id)
      );
      const commitRulePermission = new CfnPermission(
        this,
        `baws-commit-permission-${this.id}`,
        Events.getNotifyPermission(notifyArn, commitRule)
      );
      commitRulePermission.addDependsOn(commitRule);

      const buildRule = new CfnRule(
        this,
        `baws-build-rule-${this.id}`,
        Events.getBuildRuleProps(notifyArn, this.id)
      );
      const bulidRulePermission = new CfnPermission(
        this,
        `baws-build-permission-${this.id}`,
        Events.getNotifyPermission(notifyArn, buildRule)
      );
      bulidRulePermission.addDependsOn(buildRule);

      const ecsRule = new CfnRule(
        this,
        `baws-ecs-rule-${this.id}`,
        Events.getEcsRuleProps(notifyArn, this.id)
      );
      const ecsRulePermission = new CfnPermission(
        this,
        `baws-ecs-permission-${this.id}`,
        Events.getNotifyPermission(notifyArn, ecsRule)
      );
      ecsRulePermission.addDependsOn(ecsRule);
    }

    if (this.props.cdn) {
      config.cdn.distributions.forEach((item: any) => {
        const originAccessIdentity = new CfnCloudFrontOriginAccessIdentity(
          this,
          `baws-cf-identity-${this.id}-${item.name}`,
          {
            cloudFrontOriginAccessIdentityConfig: {
              comment: "Created by baws."
            }
          }
        );
        let assetBucketDomain = "";
        const assetBucket = bucketMap.get("assets");
        if (typeof assetBucket !== "undefined") {
          assetBucketDomain = assetBucket.domain;
        }

        new CfnDistribution(
          this,
          `baws-distribution-${this.id}-${item.name}`,
          CDN.getDistributionConfig(config.cdn, originAccessIdentity, {
            albDomain: alb.attrDnsName,
            targetOriginId: alb.attrLoadBalancerName,
            bucketDNS: assetBucketDomain
          })
        );
      });
    }
  };
}

interface StackSecurityGroups {
  ec2: CfnSecurityGroup;
  alb: CfnSecurityGroup;
  rds: CfnSecurityGroup;
  efs: CfnSecurityGroup;
  cache: CfnSecurityGroup;
}

interface StackRoles {
  ec2: CfnRole;
  ec2Instance: CfnInstanceProfile;
  ecsExecution: CfnRole;
  ecsTask: CfnRole;
}

interface BawsProps extends StackProps {
  efs?: boolean;
  cache?: boolean;
  rds?: boolean;
  cdn?: boolean;
}

interface BucketProps {
  name: string;
  arn: string;
  domain: string;
}
