#!/usr/bin/env python3
"""Rebuild models/mtcnn_{pnet,rnet,onet}.onnx from facenet-pytorch's pretrained MTCNN weights, without PyTorch.

  pip download facenet-pytorch==2.6.0 --no-deps   # then unzip the wheel
  python3 scripts/convert-mtcnn.py <unzipped>/facenet_pytorch/data models/

Needs numpy and onnx. The .pt files use PyTorch's legacy (non-zip) format, read here with a small unpickler.
"""
import sys
from onnx import helper as h, TensorProto as T, numpy_helper as nh
import onnx
import pickle, struct, numpy as np, collections
DT={'FloatStorage':np.float32,'DoubleStorage':np.float64,'LongStorage':np.int64}
def load(path):
    f=open(path,'rb')
    up=lambda: pickle.load(f)
    magic=up(); proto=up(); sysinfo=up()
    storages={}
    class U(pickle.Unpickler):
        def persistent_load(self,pid):
            typename,storage_type,key,location,size=pid[0],pid[1],pid[2],pid[3],pid[4]
            name=storage_type.__name__ if hasattr(storage_type,'__name__') else str(storage_type)
            storages.setdefault(key,[name,size,None]); return ('S',key)
        def find_class(self,mod,name):
            if mod=='torch._utils' and name=='_rebuild_tensor_v2':
                return lambda st,off,size,stride,*a: ('T',st[1],off,tuple(size),tuple(stride))
            if mod=='torch' and name.endswith('Storage'):
                return type(name,(),{})
            if mod=='collections' and name=='OrderedDict': return collections.OrderedDict
            return super().find_class(mod,name)
    obj=U(f).load()
    keys=up()
    for k in keys:
        n=struct.unpack('<q',f.read(8))[0]
        name=storages[k][0]; dt=DT[name]
        storages[k][2]=np.frombuffer(f.read(n*np.dtype(dt).itemsize),dtype=dt)
    out={}
    for name,t in obj.items():
        _,key,off,size,stride=t
        data=storages[key][2]
        out[name]=np.lib.stride_tricks.as_strided(data[off:], shape=size, strides=[s*data.itemsize for s in stride]).copy() if size else data[off:off+1].copy()
    return out

D=sys.argv[1].rstrip('/')+'/'
OUT=sys.argv[2].rstrip('/')+'/'
def net(name, w, layers, inp_shape, outputs):
    nodes=[]; inits=[]
    def init(n,a): inits.append(nh.from_array(a.astype(np.float32),n)); return n
    x='input'
    for i,(op,arg) in enumerate(layers):
        y=f't{i}'
        if op=='conv': nodes.append(h.make_node('Conv',[x,init(arg+'.weight',w[arg+'.weight']),init(arg+'.bias',w[arg+'.bias'])],[y]))
        elif op=='prelu4d': nodes.append(h.make_node('PRelu',[x,init(arg+'.weight',w[arg+'.weight'].reshape(-1,1,1))],[y]))
        elif op=='prelu': nodes.append(h.make_node('PRelu',[x,init(arg+'.weight',w[arg+'.weight'])],[y]))
        elif op=='pool': k,s=arg; nodes.append(h.make_node('MaxPool',[x],[y],kernel_shape=[k,k],strides=[s,s],ceil_mode=1))
        elif op=='permflat':
            nodes.append(h.make_node('Transpose',[x],[y+'p'],perm=[0,3,2,1])); nodes.append(h.make_node('Flatten',[y+'p'],[y],axis=1))
        elif op=='dense': nodes.append(h.make_node('Gemm',[x,init(arg+'.weight',w[arg+'.weight']),init(arg+'.bias',w[arg+'.bias'])],[y],transB=1))
        x=y
    trunk=x; outs=[]
    for oname,(op,arg,soft) in outputs.items():
        y=oname+('_raw' if soft else '')
        if op=='conv': nodes.append(h.make_node('Conv',[trunk,init(arg+'.weight',w[arg+'.weight']),init(arg+'.bias',w[arg+'.bias'])],[y]))
        else: nodes.append(h.make_node('Gemm',[trunk,init(arg+'.weight',w[arg+'.weight']),init(arg+'.bias',w[arg+'.bias'])],[y],transB=1))
        if soft: nodes.append(h.make_node('Softmax',[y],[oname],axis=1))
        outs.append(h.make_tensor_value_info(oname,T.FLOAT,['N','C','h','w'] if op=='conv' else ['N','K']))
    g=h.make_graph(nodes,name,[h.make_tensor_value_info('input',T.FLOAT,inp_shape)],outs,inits)
    m=h.make_model(g,opset_imports=[h.make_opsetid('',13)]); m.ir_version=8
    onnx.checker.check_model(m); onnx.save(m,OUT+f'mtcnn_{name}.onnx'); print(name,'ok')
p=load(D+'pnet.pt')
net('pnet',p,[('conv','conv1'),('prelu4d','prelu1'),('pool',(2,2)),('conv','conv2'),('prelu4d','prelu2'),('conv','conv3'),('prelu4d','prelu3')],
    [1,3,'H','W'],{'reg':('conv','conv4_2',False),'prob':('conv','conv4_1',True)})
r=load(D+'rnet.pt')
net('rnet',r,[('conv','conv1'),('prelu4d','prelu1'),('pool',(3,2)),('conv','conv2'),('prelu4d','prelu2'),('pool',(3,2)),('conv','conv3'),('prelu4d','prelu3'),('permflat',None),('dense','dense4'),('prelu','prelu4')],
    ['N',3,24,24],{'reg':('dense','dense5_2',False),'prob':('dense','dense5_1',True)})
o=load(D+'onet.pt')
net('onet',o,[('conv','conv1'),('prelu4d','prelu1'),('pool',(3,2)),('conv','conv2'),('prelu4d','prelu2'),('pool',(3,2)),('conv','conv3'),('prelu4d','prelu3'),('pool',(2,2)),('conv','conv4'),('prelu4d','prelu4'),('permflat',None),('dense','dense5'),('prelu','prelu5')],
    ['N',3,48,48],{'reg':('dense','dense6_2',False),'points':('dense','dense6_3',False),'prob':('dense','dense6_1',True)})
