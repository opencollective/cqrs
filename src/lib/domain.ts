import { Actor, ActorConstructor } from "./Actor";
import Service from "./Service";
import Repository from "./Repository";
import EventStore from "./DefaultEventStore";
import EventBus from "./EventBus";
const di = require("class-di")
const isLock = Symbol.for("isLock");

export default class Domain {

    public eventstore: EventStore;
    public eventbus: EventBus;
    private ActorClassMap: Map<string, ActorConstructor>;
    private repositorieMap: Map<ActorConstructor, Repository>;

    constructor(options: any = {}) {
        this.eventstore = options.EventStore ? new options.EventStore : new EventStore();
        this.eventbus = options.EventBus ? new options.EventBus(this.eventstore) : new EventBus(this.eventstore, this);
        this.ActorClassMap = new Map();
        this.repositorieMap = new Map();
    }

    private async getNativeActor(type: string, id: string): Promise<any> {
        let repo = this.repositorieMap.get(this.ActorClassMap.get(type));
        return await repo.get(id);
    }

    private async nativeCreateActor(type, data) {
        const ActorClass = this.ActorClassMap.get(type);
        const repo = this.repositorieMap.get(ActorClass);

        if (ActorClass.createBefor) {
            try {
                let result = await ActorClass.createBefor(data);
            } catch (err) {
                throw err;
            }
        }
        const actorId = (await repo.create(data)).json.id;
        return await this.getActorProxy(type, actorId);
    }

    private async getActorProxy(type: string, id: string, sagaId?: string, key?: string) {
        const that = this;
        const actor: Actor = await this.getNativeActor(type, id);
        const proxy = new Proxy(actor, {
            get(target, prop: string) {

                if (prop === "then") { return proxy };
                const member = actor[prop];

                if ("lock" === prop) {
                    return Reflect.get(target, prop);
                }

                if (typeof member === "function") {

                    return new Proxy(member, {
                        apply(target, cxt, args) {

                            return new Promise(function (resolve, reject) {
                                function run() {
                                    const islock = actor[isLock](key);

                                    if (islock) {
                                        setTimeout(run, 2000);
                                    } else {
                                        cxt = { service: new Service(actor, that.eventbus, (type, id, sagaId, key) => that.getActorProxy(type, id, sagaId, key), (type, data) => that.nativeCreateActor(type, id), prop, sagaId) };
                                        cxt.__proto__ = proxy;
                                        const result = target.call(cxt, ...args);
                                        if (result instanceof Promise) {
                                            result.then(result => resolve(result));
                                        } else {
                                            resolve(result);
                                        }
                                    }
                                }
                                run();
                            });
                        }
                    });
                } else if (prop === "json") {
                    return member;
                } else {
                    return (actor.json)[prop] || actor[prop]
                }

            }
        })
        return proxy;
    }

    register(Classes: ActorConstructor[] | ActorConstructor) {

        if (!Array.isArray(Classes)) {
            Classes = [Classes]
        }

        for (let Class of Classes) {
            this.ActorClassMap.set(Class.getType(), Class);
            this.repositorieMap.set(Class, new Repository(Class, this.eventstore));
        }

        return this;

    }

    async create(type: string, data: any) {
        return await this.nativeCreateActor(type, data);
    }

    async get(type: string, id: string) {
        return await this.getActorProxy(type, id);
    }

    on(event, handle) {
        this.eventbus.on(event, handle);
    }

    once(event, handle) {
        this.eventbus.on(event, handle);
    }


}